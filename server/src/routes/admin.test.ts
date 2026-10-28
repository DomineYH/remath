// 관리자 쓰기 라우트 (#43): 메모리 Data API 스텁으로 검수 관문·끼어들기·재설정 인수·감사를 고정한다.
// rpc 는 0002·0004 SQL 과 같은 규칙을 await 없이 한 번에 적용한다(= 한 트랜잭션). SQL 자체는 db/migrations/*.test.ts(PGlite).
import { readFileSync } from 'node:fs';
import { routes, ScenarioInput } from '@remath/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { sha256 } from '../auth.ts';
import { loadConfig } from '../config.ts';
import type { Db } from '../db.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub rows mirror untyped PostgREST JSON
type Row = Record<string, any>;
type Tables = Record<string, Row[]>;
interface Hooks { before?: (op: string, name: string) => Promise<void> | void; fail?: (op: string, name: string) => boolean }
const ROOT = new URL('../../../', import.meta.url);
const config = loadConfig({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'k', MOCK_LLM: '1' }, p => readFileSync(new URL(p, ROOT), 'utf8'));
const NOAH = ScenarioInput.parse(JSON.parse(readFileSync(new URL('db/seed/scenarios/noah.json', ROOT), 'utf8')));

let tick = Date.parse('2026-10-28T00:00:00Z');
const stamp = () => new Date(tick += 1000).toISOString();   // every write moves updated_at (set_updated_at)

/** 임베드 select 결과 = projection.ts 의 *_SELECT 가 PostgREST 에서 받는 모양. */
function view(t: Tables, table: string, r: Row): Row {
  const groupRef = (id: string) => { const g = t.groups.find(x => x.id === id)!; return { id: g.id, name: g.name }; };
  const count = (pred: (s: Row) => boolean) => [{ count: t.sessions.filter(pred).length }];
  if (table === 'auth_sessions') return { ...r, user: t.users.find(u => u.id === r.user_id) };
  if (table === 'scenarios') return { ...r,
    scenario_translations: t.scenario_translations.filter(x => x.scenario_id === r.id).map(({ scenario_id: _, ...x }) => x),
    group_scenarios: t.group_scenarios.filter(x => x.scenario_id === r.id).map(x => ({ groups: groupRef(x.group_id) })),
    sessions: count(s => s.scenario_id === r.id) };
  if (table === 'users') return { ...r,
    group_members: t.group_members.filter(m => m.user_id === r.id).map(m => ({ groups: { ...groupRef(m.group_id),
      group_scenarios: t.group_scenarios.filter(x => x.group_id === m.group_id).map(x => ({ scenario_id: x.scenario_id })) } })),
    sessions: count(s => s.user_id === r.id) };
  if (table === 'groups') return { ...r,
    group_members: t.group_members.filter(m => m.group_id === r.id).map(m => { const u = t.users.find(x => x.id === m.user_id)!; return { users: { id: u.id, nickname: u.nickname } }; }),
    group_scenarios: t.group_scenarios.filter(x => x.group_id === r.id).map(x => { const s = t.scenarios.find(y => y.id === x.scenario_id)!;
      return { scenarios: { id: s.id, lang: s.lang, status: s.status, scenario_translations: t.scenario_translations.filter(y => y.scenario_id === s.id) } }; }) };
  return r;
}

/** FK: users·groups·scenarios 삭제의 cascade, sessions.scenario_id 는 restrict. */
function remove(t: Tables, table: string, ids: string[]) {
  if (table === 'scenarios' && t.sessions.some(s => ids.includes(s.scenario_id))) return { code: '23503', message: 'restrict' };
  const drop = (name: string, pred: (r: Row) => boolean) => { t[name] = t[name].filter(r => !pred(r)); };
  drop(table, r => ids.includes(r.id));
  if (table === 'users') for (const n of ['sessions', 'group_members', 'auth_sessions']) drop(n, r => ids.includes(r.user_id));
  if (table === 'scenarios') for (const n of ['scenario_translations', 'group_scenarios']) drop(n, r => ids.includes(r.scenario_id));
  if (table === 'groups') for (const n of ['group_members', 'group_scenarios']) drop(n, r => ids.includes(r.group_id));
  return null;
}

function fakeDb(t: Tables, hooks: Hooks = {}, calls: { name: string; args: Row }[] = []) {
  const from = (table: string) => {
    let op = 'select', values: Row = {}, mode: 'many' | 'one' | 'maybe' = 'many';
    const filters: ((r: Row) => boolean)[] = [];
    const run = async () => {
      await hooks.before?.(op, table);
      if (hooks.fail?.(op, table)) return { data: null, error: { code: 'XX000', message: 'injected failure' } };
      let out: Row[];
      if (op === 'insert') {
        const r: Row = { id: crypto.randomUUID(), created_at: stamp(), updated_at: stamp(), pw_updated_at: stamp(), ...values };
        if (table === 'users' && t.users.some(u => u.nickname.toLowerCase() === r.nickname.toLowerCase())) return { data: null, error: { code: '23505', message: 'dup' } };
        t[table].push(r); out = [r];
      } else {
        out = t[table].filter(r => filters.every(f => f(r)));
        if (op === 'delete') { const e = remove(t, table, out.map(r => r.id)); if (e) return { data: null, error: e }; }
      }
      const data = structuredClone(out.map(r => view(t, table, r)));
      const picked = mode === 'many' ? data : data[0] ?? null;
      return mode === 'one' && !picked ? { data: null, error: { code: 'PGRST116', message: 'no rows' } } : { data: picked, error: null };
    };
    const b = {
      select: () => b, order: () => b, insert: (v: Row) => { op = 'insert'; values = v; return b; }, delete: () => { op = 'delete'; return b; },
      eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return b; },
      in: (c: string, v: unknown[]) => { filters.push(r => v.includes(r[c])); return b; },
      single: () => { mode = 'one'; return b; }, maybeSingle: () => { mode = 'maybe'; return b; },
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => run().then(ok, ko),
    };
    return b;
  };
  const RPC: Record<string, (a: Row) => unknown> = {
    change_password: a => {
      const u = t.users.find(x => x.id === a.p_user_id && (a.p_expected_hash === null || x.password_hash === a.p_expected_hash));
      if (!u) return false;
      Object.assign(u, { password_hash: a.p_new_hash, pw_updated_at: stamp() });
      t.auth_sessions = t.auth_sessions.filter(r => r.user_id !== a.p_user_id || (a.p_keep_token_hash !== null && r.token_hash === a.p_keep_token_hash));
      return true;
    },
    save_scenario: ({ p_id, p_slug, p_input: { translations, ...cols } }) => {
      if (p_slug !== null) t.scenarios.push({ id: p_id, slug: p_slug, created_at: stamp(), ...cols });
      const s = t.scenarios.find(x => x.id === p_id);
      if (!s) return false;
      Object.assign(s, cols, { status: 'draft', compiled_prompt: null, updated_at: stamp() });
      t.scenario_translations = t.scenario_translations.filter(x => x.scenario_id !== p_id);
      for (const lang of ['ko', 'en']) t.scenario_translations.push({ scenario_id: p_id, lang, ...translations[lang] });
      return true;
    },
    publish_scenario: a => {
      const s = t.scenarios.find(x => x.id === a.p_id && x.updated_at === a.p_expected_updated_at);
      if (!s) return false;
      Object.assign(s, { status: 'published', compiled_prompt: a.p_compiled, updated_at: stamp() });
      return true;
    },
    set_group_links: a => {
      const members = [...new Set<string>(a.p_member_ids)], scs = [...new Set<string>(a.p_scenario_ids)];
      if (!members.every(id => t.users.some(u => u.id === id && u.role === 'teacher')) || !scs.every(id => t.scenarios.some(s => s.id === id))) throw { code: '22023', message: 'bad id' };
      if (a.p_create) t.groups.push({ id: a.p_group_id, name: a.p_name, created_at: stamp() });
      const g = t.groups.find(x => x.id === a.p_group_id);
      if (!g) return false;
      g.name = a.p_name ?? g.name;
      t.group_members = [...t.group_members.filter(m => m.group_id !== g.id), ...members.map(user_id => ({ group_id: g.id, user_id }))];
      t.group_scenarios = [...t.group_scenarios.filter(m => m.group_id !== g.id), ...scs.map(scenario_id => ({ group_id: g.id, scenario_id }))];
      return true;
    },
  };
  const rpc = async (name: string, args: Row) => {
    calls.push({ name, args });
    await hooks.before?.('rpc', name);
    if (hooks.fail?.('rpc', name)) return { data: null, error: { code: 'XX000', message: 'injected failure' } };
    try { return { data: RPC[name](args), error: null }; } catch (e) { return { data: null, error: e }; }
  };
  return { from, rpc } as unknown as Db;
}

function gate() {
  let arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>(r => { arrive = r; }), opened = new Promise<void>(r => { release = r; });
  return { arrived, release, wait: () => { arrive(); return opened; } };
}
/** arm(op, name) 다음 그 연산 하나가 gate 에서 기다린다. fail 은 주입 실패. */
function pausable() {
  let armed: { op: string; name: string; g: ReturnType<typeof gate> } | null = null;
  const failing = new Set<string>();
  const hooks: Hooks = {
    before: (op, name) => { if (armed?.op === op && armed.name === name) { const g = armed.g; armed = null; return g.wait(); } },
    fail: (op, name) => failing.has(`${op} ${name}`),
  };
  return { hooks, failing, arm: (op: string, name: string) => { const g = gate(); armed = { op, name, g }; return g; } };
}

const ADMIN = crypto.randomUUID(), T1 = crypto.randomUUID(), T2 = crypto.randomUUID();
async function setup() {
  const p = pausable(), calls: { name: string; args: Row }[] = [];
  const later = new Date(Date.now() + 3600_000).toISOString();
  const t: Tables = {
    users: [
      { id: ADMIN, nickname: 'admin', role: 'admin', password_hash: 'A', pw_updated_at: stamp(), created_at: stamp() },
      { id: T1, nickname: 'kim', role: 'teacher', password_hash: 'H1', pw_updated_at: stamp(), created_at: stamp() },
      { id: T2, nickname: 'lee', role: 'teacher', password_hash: 'H2', pw_updated_at: stamp(), created_at: stamp() },
    ],
    auth_sessions: [
      { user_id: ADMIN, realm: 'admin', token_hash: sha256('adm'), expires_at: later },
      { user_id: T1, realm: 'teacher', token_hash: sha256('kim'), expires_at: later },
      { user_id: T1, realm: 'teacher', token_hash: sha256('kim2'), expires_at: later },
    ],
    scenarios: [], scenario_translations: [], groups: [], group_members: [], group_scenarios: [], sessions: [], audit_log: [],
  };
  const app = await buildApp({ db: fakeDb(t, p.hooks, calls), config });
  const req = (method: string, url: string, payload?: unknown, cookie = 'adm') =>
    app.inject({ method: method as 'GET', url, payload: payload as object, cookies: { remath_admin: cookie } });
  const actions = () => t.audit_log.map(a => a.action);
  const createScenario = async (body: unknown = NOAH) => (await req('POST', '/api/admin/scenarios', body)).json().id as string;
  return { t, p, calls, app, req, actions, createScenario };
}
const ALL = ['m1', 'm2', 'm3', 'm4'];

describe('admin realm only (C-9)', () => {
  it('every admin data route refuses a teacher cookie and no cookie with 401 before touching data', async () => {
    const s = await setup();
    const ours = routes.filter(r => /^\/api\/admin\/(scenarios|users|groups)/.test(r.path));
    expect(ours).toHaveLength(16);
    for (const r of ours) {
      const url = r.path.replace(':id', T1);
      const teacher = await s.app.inject({ method: r.method, url, cookies: { remath_teacher: 'kim' }, payload: {} });
      const none = await s.app.inject({ method: r.method, url, payload: {} });
      expect([teacher.statusCode, none.statusCode], `${r.method} ${r.path}`).toEqual([401, 401]);
    }
    expect(s.calls).toEqual([]);
  });
});

describe('scenarios', () => {
  it('create is one save_scenario call: 201 draft with both translations, audited with the slug', async () => {
    const s = await setup();
    const r = await s.req('POST', '/api/admin/scenarios', NOAH);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: 'draft', translations: { ko: { name: NOAH.translations.ko.name } } });
    expect(r.json()).not.toHaveProperty('compiled_prompt');
    expect(s.calls.map(c => c.name)).toEqual(['save_scenario']);
    expect(s.t.audit_log).toEqual([expect.objectContaining({ actor_id: ADMIN, action: 'scenario.create', target: r.json().id, meta: { slug: r.json().slug } })]);
  });

  it('a failed save writes nothing and no audit', async () => {
    const s = await setup();
    s.p.failing.add('rpc save_scenario');
    expect((await s.req('POST', '/api/admin/scenarios', NOAH)).statusCode).toBe(500);
    expect([s.t.scenarios, s.t.scenario_translations, s.t.audit_log]).toEqual([[], [], []]);
  });

  it('publish gates: failing auto checks or fewer than 4 distinct confirmations are 422 with the ReviewResult, nothing published', async () => {
    const s = await setup();
    const empty = await s.createScenario(ScenarioInput.parse({ ...NOAH, translations: { ko: {}, en: {} }, internal: {}, }));
    const bad = await s.req('POST', `/api/admin/scenarios/${empty}/publish`, { confirmed: ALL });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toMatchObject({ code: 'review_failed', details: { publishable: false } });
    const ok = await s.createScenario();
    const three = await s.req('POST', `/api/admin/scenarios/${ok}/publish`, { confirmed: ['m1', 'm2', 'm3', 'm3'] });
    expect(three.statusCode).toBe(422);
    expect(three.json().error).toMatchObject({ code: 'review_failed', details: { publishable: true } });
    expect(s.t.scenarios.map(x => x.status)).toEqual(['draft', 'draft']);
    expect(s.actions()).toEqual(['scenario.create', 'scenario.create']);
  });

  it('publish stores the compiled prompt of what was reviewed; PUT takes it back to draft/null', async () => {
    const s = await setup();
    const id = await s.createScenario();
    const pub = await s.req('POST', `/api/admin/scenarios/${id}/publish`, { confirmed: ALL });
    expect(pub.json().status).toBe('published');
    const prompt = s.t.scenarios[0].compiled_prompt;
    expect(prompt.student).toContain(NOAH.translations[NOAH.lang].name);
    expect((await s.req('GET', `/api/admin/scenarios/${id}/prompt`)).json()).toEqual(prompt);
    expect((await s.req('PUT', `/api/admin/scenarios/${id}`, NOAH)).json().status).toBe('draft');
    expect(s.t.scenarios[0]).toMatchObject({ status: 'draft', compiled_prompt: null });
    expect(s.t.audit_log.map(a => [a.action, a.meta])).toEqual([
      ['scenario.create', { slug: pub.json().slug }], ['scenario.publish', { slug: pub.json().slug, lang: NOAH.lang }], ['scenario.update', { slug: pub.json().slug }]]);
  });

  it('a draft save landing between publish review and publish write: publish is refused 422, nothing unreviewed is published', async () => {
    const s = await setup();
    const id = await s.createScenario();
    const g = s.p.arm('rpc', 'publish_scenario');
    const publishing = s.req('POST', `/api/admin/scenarios/${id}/publish`, { confirmed: ALL });
    await g.arrived;                                          // reviewed and compiled the old content, about to write
    const broken = structuredClone(NOAH);
    broken.translations[NOAH.lang].problem = '';                // would fail c1
    expect((await s.req('PUT', `/api/admin/scenarios/${id}`, broken)).statusCode).toBe(200);
    g.release();
    const r = await publishing;
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: 'review_failed', details: { publishable: false } });   // review of the current content
    expect(s.t.scenarios[0]).toMatchObject({ status: 'draft', compiled_prompt: null });
    expect(s.actions()).toEqual(['scenario.create', 'scenario.update']);
  });

  it('a publish completing while a draft save is in flight: the save still ends as draft/null with its own translations', async () => {
    const s = await setup();
    const id = await s.createScenario();
    const g = s.p.arm('rpc', 'save_scenario');
    const changed = structuredClone(NOAH);
    changed.translations[NOAH.lang].problem = 'changed';
    const saving = s.req('PUT', `/api/admin/scenarios/${id}`, changed);
    await g.arrived;
    expect((await s.req('POST', `/api/admin/scenarios/${id}/publish`, { confirmed: ALL })).statusCode).toBe(200);
    g.release();
    expect((await saving).statusCode).toBe(200);
    expect(s.t.scenarios[0]).toMatchObject({ status: 'draft', compiled_prompt: null });
    expect(s.t.scenario_translations.find(x => x.lang === NOAH.lang)!.problem).toBe('changed');
  });

  it('delete with sessions is 409 with the count and keeps the scenario, no audit', async () => {
    const s = await setup();
    const id = await s.createScenario();
    s.t.sessions.push({ id: crypto.randomUUID(), user_id: T1, scenario_id: id }, { id: crypto.randomUUID(), user_id: T2, scenario_id: id });
    const r = await s.req('DELETE', `/api/admin/scenarios/${id}`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'scenario_has_sessions', details: { session_count: 2 } });
    expect(s.t.scenarios).toHaveLength(1);
    expect(s.actions()).toEqual(['scenario.create']);
  });
});

describe('users', () => {
  it('reset calls change_password(id, null, new argon2id hash, null): every login of that user ends; audit has the nickname only', async () => {
    const s = await setup();
    const r = await s.req('PUT', `/api/admin/users/${T1}/password`, { password: 'zz43reset9' });
    expect(r.statusCode).toBe(204);
    expect(s.calls).toEqual([{ name: 'change_password', args: { p_user_id: T1, p_expected_hash: null, p_new_hash: expect.stringMatching(/^\$argon2id\$/), p_keep_token_hash: null } }]);
    expect(s.t.auth_sessions.filter(x => x.user_id === T1)).toEqual([]);
    expect(s.t.audit_log).toEqual([expect.objectContaining({ action: 'user.password_reset', target: T1, meta: { nickname: 'kim' } })]);
    expect(JSON.stringify(s.t.audit_log)).not.toMatch(/zz43reset9|argon2/);
  });

  it('reset of the admin id is 404 and calls nothing', async () => {
    const s = await setup();
    expect((await s.req('PUT', `/api/admin/users/${ADMIN}/password`, { password: 'zz43reset9' })).statusCode).toBe(404);
    expect([s.calls, s.t.audit_log]).toEqual([[], []]);
  });

  it('delete cascades and is audited with nickname and session_count; a failed delete is not audited', async () => {
    const s = await setup();
    s.t.sessions.push({ id: crypto.randomUUID(), user_id: T1, scenario_id: crypto.randomUUID() });
    s.p.failing.add('delete users');
    expect((await s.req('DELETE', `/api/admin/users/${T1}`)).statusCode).toBe(500);
    expect(s.t.audit_log).toEqual([]);
    s.p.failing.clear();
    expect((await s.req('DELETE', `/api/admin/users/${T1}`)).statusCode).toBe(204);
    expect([s.t.sessions, s.t.auth_sessions.filter(x => x.user_id === T1)]).toEqual([[], []]);
    expect(s.t.audit_log).toEqual([expect.objectContaining({ action: 'user.delete', target: T1, meta: { nickname: 'kim', session_count: 1 } })]);
  });
});

describe('groups', () => {
  async function withGroup() {
    const s = await setup();
    const x = await s.createScenario(), y = await s.createScenario();
    const g = await s.req('POST', '/api/admin/groups', { name: 'A', member_ids: [T1], scenario_ids: [x] });
    s.t.audit_log = []; s.calls.length = 0;
    const links = () => ({ members: s.t.group_members.map(m => m.user_id), scenarios: s.t.group_scenarios.map(m => m.scenario_id) });
    return { ...s, x, y, gid: g.json().id as string, links };
  }

  it('create is 201 with joined members and scenarios, one set_group_links call', async () => {
    const s = await setup();
    const x = await s.createScenario();
    const r = await s.req('POST', '/api/admin/groups', { name: 'A', member_ids: [T1, T1, T2], scenario_ids: [x] });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'A', members: [{ id: T1, nickname: 'kim' }, { id: T2, nickname: 'lee' }], scenarios: [{ id: x, status: 'draft' }] });
    expect(s.calls.filter(c => c.name === 'set_group_links')).toHaveLength(1);
    expect(s.t.audit_log.at(-1)).toMatchObject({ action: 'group.create', meta: { name: 'A', member_count: 2, scenario_count: 1 } });
  });

  it('a failed replacement changes neither link set: the excluded member gains no access; no audit', async () => {
    const s = await withGroup();
    s.p.failing.add('rpc set_group_links');
    expect((await s.req('PUT', `/api/admin/groups/${s.gid}`, { name: 'B', member_ids: [T2], scenario_ids: [s.y] })).statusCode).toBe(500);
    expect(s.links()).toEqual({ members: [T1], scenarios: [s.x] });
    expect(s.t.groups[0].name).toBe('A');
    expect(s.t.audit_log).toEqual([]);
  });

  it('an admin member is 400 and nothing changes', async () => {
    const s = await withGroup();
    const r = await s.req('PUT', `/api/admin/groups/${s.gid}`, { name: 'B', member_ids: [ADMIN], scenario_ids: [s.y] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_failed');
    expect(s.links()).toEqual({ members: [T1], scenarios: [s.x] });
    expect(s.t.audit_log).toEqual([]);
  });

  it('update replaces both sets and the name in one call and is audited; an unknown group is 404', async () => {
    const s = await withGroup();
    const r = await s.req('PUT', `/api/admin/groups/${s.gid}`, { name: 'B', member_ids: [T2], scenario_ids: [s.y] });
    expect(r.statusCode).toBe(200);
    expect(s.links()).toEqual({ members: [T2], scenarios: [s.y] });
    expect(s.calls.map(c => c.name)).toEqual(['set_group_links']);
    expect(s.t.audit_log).toEqual([expect.objectContaining({ action: 'group.update', target: s.gid, meta: { name: 'B', member_count: 1, scenario_count: 1 } })]);
    expect((await s.req('PUT', `/api/admin/groups/${crypto.randomUUID()}`, { name: 'C', member_ids: [], scenario_ids: [] })).statusCode).toBe(404);
  });
});
