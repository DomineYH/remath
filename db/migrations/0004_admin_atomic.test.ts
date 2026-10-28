// T-3: 0004_admin_atomic.sql on PGlite after 0001 + 0002 (#43 rev 2). Independent of 0003 (#42).
// PGlite is one connection: the row-lock wait between publish_scenario and save_scenario is reasoned (SQL comments);
// what runs here is each function's all-or-nothing effect and the updated_at guard.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

const file = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8');
const sql = file('0004_admin_atomic.sql');
const db = new PGlite();
const rows = async <T = Record<string, unknown>>(q: string, p?: unknown[]) => (await db.query<T>(q, p)).rows;
const one = async <T = Record<string, unknown>>(q: string, p?: unknown[]) => (await rows<T>(q, p))[0];
const asRole = async (role: string, fn: () => Promise<unknown>) => {
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
};
const SAVE = 'save_scenario(uuid, text, jsonb)', PUBLISH = 'publish_scenario(uuid, timestamptz, jsonb)';
const LINKS = 'set_group_links(uuid, uuid[], uuid[], text, boolean)';

const tr = (name: string) => ({ name, description: '', problem: `${name}?`, chars: '', greet: '', aha: '', t1: '', t2: '', t3: '', confused: [], elicit: [], misconceptions: [] });
const input = (ko: string, en: string, grade = '3') => ({ lang: 'ko', student_prefix: '', mentor_prefix: '', grade,
  internal: { misconceptions: [] }, classification: { leverage: [], object: [] }, translations: { ko: tr(ko), en: tr(en) } });
const save = (id: string, slug: string | null, body: unknown) =>
  one<{ ok: boolean }>(`select save_scenario($1, $2, $3) as ok`, [id, slug, JSON.stringify(body)]).then(r => r.ok);
const publish = (id: string, at: string, compiled: unknown) =>
  one<{ ok: boolean }>(`select publish_scenario($1, $2, $3) as ok`, [id, at, JSON.stringify(compiled)]).then(r => r.ok);
const links = (gid: string, members: string[], scenarios: string[], name: string | null = null, create = false) =>
  one<{ ok: boolean }>(`select set_group_links($1, $2::uuid[], $3::uuid[], $4, $5) as ok`, [gid, members, scenarios, name, create]).then(r => r.ok);
const state = (id: string) => one<{ status: string; compiled: unknown; grade: string; at: string }>(
  `select status, compiled_prompt as compiled, grade, updated_at::text as at from scenarios where id = $1`, [id]);
const names = (id: string) => rows<{ lang: string; name: string }>(`select lang, name from scenario_translations where scenario_id = $1 order by lang`, [id])
  .then(r => r.map(x => `${x.lang}:${x.name}`));
const linksOf = async (gid: string) => ({
  members: (await rows<{ id: string }>(`select user_id as id from group_members where group_id = $1 order by user_id`, [gid])).map(r => r.id),
  scenarios: (await rows<{ id: string }>(`select scenario_id as id from group_scenarios where group_id = $1 order by scenario_id`, [gid])).map(r => r.id),
});
const uuid = () => crypto.randomUUID();
const sorted = (xs: string[]) => [...xs].sort();

let t1: string, t2: string, adm: string;
beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  await db.exec(file('0001_init.sql'));
  await db.exec(file('0002_auth_atomic.sql'));
  await db.exec(sql);
  const user = async (nick: string, role = 'teacher') =>
    (await one<{ id: string }>(`insert into users (nickname, password_hash, role) values ($1, 'h', $2) returning id`, [nick, role])).id;
  t1 = await user('t1'); t2 = await user('t2'); adm = await user('admin', 'admin');
}, 60_000);

describe('apply (D-15)', () => {
  it('records itself after 0001 + 0002 and refuses a second run', async () => {
    expect(await rows('select version, name from schema_migrations order by version'))
      .toEqual([{ version: '0001', name: 'init' }, { version: '0002', name: 'auth_atomic' }, { version: '0004', name: 'admin_atomic' }]);
    await expect(db.exec(sql)).rejects.toThrow(/migration 0004 already applied/);
  });
  it('is a single psql file: no concurrently, no transaction control', () => {
    const code = sql.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\bconcurrently\b/i);
    expect(code).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);
    expect(sql.trimEnd()).toMatch(/insert into schema_migrations \(version, name\) values \('0004', 'admin_atomic'\);$/);
  });
});

describe('privileges', () => {
  it('the three functions run as the caller with a fixed search_path', async () => {
    const fns = await rows(`select proname, prosecdef, proconfig from pg_proc
      where pronamespace = 'public'::regnamespace and proname in ('save_scenario', 'publish_scenario', 'set_group_links') order by proname`);
    expect(fns).toEqual(['publish_scenario', 'save_scenario', 'set_group_links'].map(proname => ({ proname, prosecdef: false, proconfig: ['search_path=public'] })));
  });
  it('PUBLIC, anon and authenticated cannot execute them; service_role can', async () => {
    for (const f of [SAVE, PUBLISH, LINKS]) {
      expect(await rows(`select 1 from pg_proc, aclexplode(proacl) a where oid = $1::regprocedure and a.grantee = 0`, [f]), f).toEqual([]);
      for (const role of ['anon', 'authenticated']) {
        expect((await one<{ x: boolean }>(`select has_function_privilege($1, $2, 'execute') as x`, [role, f])).x, `${role} ${f}`).toBe(false);
      }
      expect((await one<{ x: boolean }>(`select has_function_privilege('service_role', $1, 'execute') as x`, [f])).x, f).toBe(true);
    }
    for (const role of ['anon', 'authenticated']) {
      await expect(asRole(role, () => save(uuid(), 'x', input('a', 'b')))).rejects.toThrow(/permission denied/);
      await expect(asRole(role, () => links(uuid(), [], [], 'x', true))).rejects.toThrow(/permission denied/);
    }
    const id = uuid();
    expect(await asRole('service_role', () => save(id, 'svc', input('a', 'b')))).toBe(true);
    await db.query(`delete from scenarios where id = $1`, [id]);
  });
});

describe('save_scenario: the row and both translations in one call', () => {
  const id = uuid();
  it('creates a draft with both translation rows', async () => {
    expect(await save(id, 'scenario-1', input('노아', 'Noah'))).toBe(true);
    expect(await state(id)).toMatchObject({ status: 'draft', compiled: null, grade: '3' });
    expect(await names(id)).toEqual(['en:Noah', 'ko:노아']);
  });
  it('a failing create leaves no scenario row behind (no orphan without translations)', async () => {
    const bad = input('x', 'y');
    (bad.translations.en as Record<string, unknown>).name = null;   // NOT NULL violation on the second translation insert
    const orphan = uuid();
    await expect(save(orphan, 'scenario-orphan', bad)).rejects.toThrow(/null value/);
    expect(await rows(`select 1 from scenarios where id = $1`, [orphan])).toEqual([]);
  });
  it('update takes a published scenario back to draft/null, replaces translations and moves updated_at', async () => {
    const before = await state(id);
    expect(await publish(id, before.at, { student: 's', analysis: null, mentor: 'm' })).toBe(true);
    const published = await state(id);
    expect(published.status).toBe('published');
    expect(await save(id, null, input('노아2', 'Noah2', '4'))).toBe(true);
    const after = await state(id);
    expect(after).toMatchObject({ status: 'draft', compiled: null, grade: '4' });
    expect(after.at).not.toBe(published.at);
    expect(await names(id)).toEqual(['en:Noah2', 'ko:노아2']);
  });
  it('a failing update changes nothing: still published with the reviewed translations', async () => {
    expect(await publish(id, (await state(id)).at, { student: 's2', analysis: null, mentor: 'm2' })).toBe(true);
    const before = await state(id);
    const bad = input('changed', 'changed', '9');
    (bad.translations.en as Record<string, unknown>).problem = null;
    await expect(save(id, null, bad)).rejects.toThrow(/null value/);
    expect(await state(id)).toEqual(before);
    expect(await names(id)).toEqual(['en:Noah2', 'ko:노아2']);
  });
  it('update of an unknown id is false and creates nothing', async () => {
    const ghost = uuid();
    expect(await save(ghost, null, input('a', 'b'))).toBe(false);
    expect(await rows(`select 1 from scenario_translations where scenario_id = $1`, [ghost])).toEqual([]);
  });
});

describe('publish_scenario: only the content that was reviewed', () => {
  it('a save after the read makes the publish false and changes nothing', async () => {
    const id = uuid();
    await save(id, 'scenario-race', input('a', 'b'));
    const read = (await state(id)).at;                       // publish handler reads and reviews here
    await save(id, null, input('unreviewed', 'unreviewed'));  // a draft save lands in between (translations only change)
    expect(await publish(id, read, { student: 'old', analysis: null, mentor: 'old' })).toBe(false);
    expect(await state(id)).toMatchObject({ status: 'draft', compiled: null });
    expect(await publish(id, (await state(id)).at, { student: 'new', analysis: null, mentor: 'new' })).toBe(true);
  });
  it('a deleted scenario is false', async () => {
    expect(await publish(uuid(), new Date().toISOString(), {})).toBe(false);
  });
});

describe('set_group_links: both link sets replaced together or not at all', () => {
  const gid = uuid();
  let sa: string, sb: string;
  beforeAll(async () => {
    sa = uuid(); sb = uuid();
    await save(sa, 'g-a', input('a', 'a')); await save(sb, 'g-b', input('b', 'b'));
  });
  it('creates the group with deduplicated links', async () => {
    expect(await links(gid, [t1, t1], [sa], 'A', true)).toBe(true);
    expect(await linksOf(gid)).toEqual({ members: [t1], scenarios: [sa] });
    expect((await one<{ name: string }>(`select name from groups where id = $1`, [gid])).name).toBe('A');
  });
  it('replaces both sets and the name', async () => {
    expect(await links(gid, [t2], [sb], 'B')).toBe(true);
    expect(await linksOf(gid)).toEqual({ members: [t2], scenarios: [sb] });
    expect((await one<{ name: string }>(`select name from groups where id = $1`, [gid])).name).toBe('B');
  });
  it('an admin member raises 22023 and nothing changes: no access gained or lost', async () => {
    await expect(links(gid, [t1, adm], [sa], 'C')).rejects.toMatchObject({ code: '22023' });
    expect(await linksOf(gid)).toEqual({ members: [t2], scenarios: [sb] });
    expect((await one<{ name: string }>(`select name from groups where id = $1`, [gid])).name).toBe('B');
  });
  it('an unknown member or scenario raises 22023 and nothing changes', async () => {
    await expect(links(gid, [t1], [uuid()])).rejects.toMatchObject({ code: '22023' });
    await expect(links(gid, [uuid()], [sa])).rejects.toMatchObject({ code: '22023' });
    expect(await linksOf(gid)).toEqual({ members: [t2], scenarios: [sb] });
  });
  it('a failing create leaves no group', async () => {
    const g = uuid();
    await expect(links(g, [adm], [], 'X', true)).rejects.toMatchObject({ code: '22023' });
    expect(await rows(`select 1 from groups where id = $1`, [g])).toEqual([]);
  });
  it('empty sets clear the links; an unknown group is false', async () => {
    expect(await links(gid, [], [])).toBe(true);
    expect(await linksOf(gid)).toEqual({ members: [], scenarios: [] });
    expect(await links(uuid(), [t1], [sa])).toBe(false);
  });
  it('teacher_scenarios follows the links', async () => {
    await db.query(`update scenarios set status = 'published', compiled_prompt = '{}' where id = any($1::uuid[])`, [[sa, sb]]);
    await links(gid, [t1, t2], [sa, sb]);
    const visible = async (u: string) => sorted((await rows<{ id: string }>(`select id from teacher_scenarios($1)`, [u])).map(r => r.id));
    expect(await visible(t1)).toEqual(sorted([sa, sb]));
    await links(gid, [t2], [sb]);
    expect(await visible(t1)).toEqual([]);
    expect(await visible(t2)).toEqual([sb]);
  });
});
