/// <reference types="vite/client" />   // 목의 import.meta.env 를 서버 tsc 가 검사한다
// 관리자 기록·CSV·AI 설정 라우트 (#44): 메모리 Data API 가짜로 필터·최신순·키셋 쪽·CSV 응답·AI 검증(목과 같은 입력 → 같은 결과)을 고정한다.
import { readFileSync } from 'node:fs';
import * as S from '@remath/shared';
import { AdapterError } from '@remath/shared/engine';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ADMIN_PW, mockTarget } from '../../../client/src/api/seam.ts';
import { ApiError } from '../../../client/src/api/types.ts';
import { buildApp } from '../app.ts';
import { sha256 } from '../auth.ts';
import { loadConfig } from '../config.ts';
import type { Db } from '../db.ts';
import type { ProvidersFor } from '../providers/types.ts';
import { open } from '../vault.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub rows mirror untyped PostgREST JSON
type Row = Record<string, any>;
type Tables = Record<string, Row[]>;
const ROOT = new URL('../../../', import.meta.url);
const config = loadConfig({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'k', MOCK_LLM: '1' }, p => readFileSync(new URL(p, ROOT), 'utf8'));
const T0 = '2026-10-28T00:00:00.000Z';

/** sessions 의 임베드(user·scenario·turns) = SESSION_*_SELECT 가 PostgREST 에서 받는 모양. turns 는 seq 순. */
function view(t: Tables, table: string, r: Row): Row {
  if (table === 'auth_sessions') return { ...r, user: t.users.find(u => u.id === r.user_id) };
  if (table === 'sessions') return { ...r,
    user: { nickname: t.users.find(u => u.id === r.user_id)!.nickname },
    scenario: { scenario_translations: t.scenario_translations.filter(x => x.scenario_id === r.scenario_id).map(x => ({ lang: x.lang, name: x.name })) },
    turns: t.turns.filter(x => x.session_id === r.id).sort((a, b) => a.seq - b.seq).map(({ session_id: _, ...x }) => x) };
  return r;
}

/** started_at.lt."X",and(started_at.eq."X",id.lt.Y) — admin-sessions.ts 의 키셋 조건만 해석한다. */
const keyset = (s: string) => {
  const m = /^started_at\.lt\."(.+)",and\(started_at\.eq\."(.+)",id\.lt\.(.+)\)$/.exec(s);
  if (!m) throw new Error(`unexpected or(): ${s}`);
  return (r: Row) => r.started_at < m[1] || (r.started_at === m[2] && r.id < m[3]);
};

/** maxRows = PostgREST max-rows: 한 요청이 돌려주는 행의 상한(limit·range 보다 작으면 말없이 잘린다). */
function fakeDb(t: Tables, calls: string[] = [], fail?: (table: string, n: number) => boolean, maxRows = Infinity) {
  let n = 0;
  const from = (table: string) => {
    let op = 'select', values: Row[] = [], mode: 'many' | 'maybe' = 'many', limit = Infinity, offset = 0;
    const filters: ((r: Row) => boolean)[] = [], orders: [string, boolean][] = [];
    const run = async () => {
      calls.push(`${op} ${table}`);
      if (fail?.(table, n++)) return { data: null, error: { code: 'XX000', message: 'injected failure' } };
      let out: Row[];
      if (op === 'insert') { t[table].push(...values); out = values; }
      else if (op === 'upsert') out = values.map(v => { const r = t[table].find(x => x.role === v.role)!; Object.assign(r, v); return r; });
      else {
        out = t[table].filter(r => filters.every(f => f(r)));
        for (const [c, asc] of [...orders].reverse()) out.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
        out = out.slice(offset, offset + Math.min(limit, maxRows));
      }
      const data = structuredClone(out.map(r => view(t, table, r)));
      return { data: mode === 'many' ? data : data[0] ?? null, error: null };
    };
    const b = {
      select: () => b, insert: (v: Row) => { op = 'insert'; values = [v]; return b; },
      upsert: (v: Row[], o: { onConflict: string }) => { expect(o.onConflict).toBe('role'); op = 'upsert'; values = v; return b; },
      eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return b; },
      or: (s: string) => { filters.push(keyset(s)); return b; },
      order: (c: string, o?: { ascending?: boolean; referencedTable?: string }) => { if (!o?.referencedTable) orders.push([c, o?.ascending ?? true]); return b; },
      limit: (k: number) => { limit = k; return b; },
      range: (a: number, z: number) => { offset = a; limit = z - a + 1; return b; },
      maybeSingle: () => { mode = 'maybe'; return b; },
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => run().then(ok, ko),
    };
    return b;
  };
  return { from, rpc: () => { throw new Error('no rpc in admin reads'); } } as unknown as Db;
}

const ADMIN = crypto.randomUUID(), KIM = crypto.randomUUID(), LEE = crypto.randomUUID(), GAB = crypto.randomUUID(), NOAH = crypto.randomUUID();
const aiRow = (role: string) => ({ role, key_source: role === 'student' ? 'own' : 'student', provider: null, key_ciphertext: null, key_masked: null, key_added_at: null, model: null, effort: null, created_at: T0 });

async function setup(o: { sessions?: number; fail?: (table: string, n: number) => boolean; maxRows?: number; config?: typeof config; providersFor?: ProvidersFor } = {}) {
  const later = new Date(Date.now() + 3600_000).toISOString(), calls: string[] = [];
  const t: Tables = {
    users: [{ id: ADMIN, nickname: 'admin', role: 'admin' }, { id: KIM, nickname: 'kim', role: 'teacher' }, { id: LEE, nickname: 'lee', role: 'teacher' }],
    auth_sessions: [{ user_id: ADMIN, realm: 'admin', token_hash: sha256('adm'), expires_at: later }, { user_id: KIM, realm: 'teacher', token_hash: sha256('kim'), expires_at: later }],
    scenario_translations: [
      { scenario_id: GAB, lang: 'ko', name: '가브리엘' }, { scenario_id: GAB, lang: 'en', name: 'Gabriel' },
      { scenario_id: NOAH, lang: 'ko', name: '노아' }, { scenario_id: NOAH, lang: 'en', name: 'Noah' },
    ],
    sessions: [], turns: [], audit_log: [],
    ai_settings: ['student', 'mentor', 'analysis'].map(aiRow),
  };
  // o.sessions 개: 같은 started_at 이 둘씩(키셋의 id 동률 갈래), 사용자·시나리오·lang 이 번갈아
  for (let i = 0; i < (o.sessions ?? 0); i++) {
    const id = crypto.randomUUID(), started_at = new Date(Date.parse(T0) + 1000 * Math.floor(i / 2)).toISOString().replace('Z', '+00:00');
    t.sessions.push({ id, user_id: i % 3 ? KIM : LEE, scenario_id: i % 2 ? GAB : NOAH, lang: i % 4 < 2 ? 'ko' : 'en', started_at, ended_at: null,
      goal_reached: i % 5 === 0, report: null, progress: { mis: [i % 3, 0] }, counts: { Eliciting: i }, turn_started_at: null });
    t.turns.push({ session_id: id, seq: 2, speaker: 'teacher', text: `t${i} "q"\r\nx`, leverage: 'Eliciting', object: null, trigger: null, created_at: started_at },
      { session_id: id, seq: 1, speaker: 'student', text: 'hi', leverage: null, object: null, trigger: null, created_at: started_at },
      { session_id: id, seq: 3, speaker: 'mentor', text: 'm', leverage: null, object: null, trigger: i % 3 === 0 ? 2 : null, created_at: started_at });
  }
  const app = await buildApp({ db: fakeDb(t, calls, o.fail, o.maxRows), config: o.config ?? config, now: () => new Date(T0), ...o.providersFor && { providersFor: o.providersFor } });
  const req = (method: string, url: string, payload?: unknown, cookies: Record<string, string> = { remath_admin: 'adm' }) =>
    app.inject({ method: method as 'GET', url, payload: payload as object, cookies });
  const newest = () => [...t.sessions].sort((a, b) => b.started_at < a.started_at ? -1 : b.started_at > a.started_at ? 1 : b.id < a.id ? -1 : 1);
  return { t, calls, req, newest };
}

describe('admin realm only (C-9)', () => {
  it('the session and AI routes refuse a teacher cookie and no cookie with 401 before reading data', async () => {
    const s = await setup();
    const ours = S.routes.filter(r => /^\/api\/admin\/(sessions|ai)/.test(r.path));
    expect(ours).toHaveLength(6);
    for (const r of ours) {
      const url = r.path.replace(':id', KIM).replace(':role', 'student');
      const teacher = await s.req(r.method, url, {}, { remath_teacher: 'kim' }), none = await s.req(r.method, url, {}, {});
      expect([teacher.statusCode, none.statusCode], `${r.method} ${r.path}`).toEqual([401, 401]);
    }
    expect(s.calls.filter(c => !c.endsWith('auth_sessions'))).toEqual([]);
  });
});

describe('GET /api/admin/sessions (E-19)', () => {
  it('every user, newest first across key-set pages, no duplicates; filters by user and scenario', async () => {
    const s = await setup({ sessions: 250 });
    const all = (await s.req('GET', '/api/admin/sessions')).json() as z.infer<typeof S.SessionRow>[];
    expect(all.map(r => r.id)).toEqual(s.newest().map(r => r.id));
    expect(s.calls.filter(c => c === 'select sessions')).toHaveLength(3);
    expect(all[0]).toEqual(S.SessionRow.strict().parse(all[0]));
    const kim = (await s.req('GET', `/api/admin/sessions?user_id=${KIM}&scenario_id=${GAB}`)).json() as z.infer<typeof S.SessionRow>[];
    expect(kim.map(r => r.id)).toEqual(s.newest().filter(r => r.user_id === KIM && r.scenario_id === GAB).map(r => r.id));
    expect(kim.every(r => r.nickname === 'kim' && r.turn_count === 1 && r.scenario_name === (r.lang === 'ko' ? '가브리엘' : 'Gabriel'))).toBe(true);
    expect((await s.req('GET', '/api/admin/sessions?user_id=nope')).statusCode).toBe(400);
  });
});

describe('lists are not cut at the Data API max-rows (review: unpaged reads)', () => {
  it('teacher history GET /api/sessions returns every own session newest first past a 100-row cap', async () => {
    const s = await setup({ sessions: 250, maxRows: 100 });
    const mine = (await s.req('GET', '/api/sessions', undefined, { remath_teacher: 'kim' })).json() as z.infer<typeof S.SessionRow>[];
    const kim = s.newest().filter(r => r.user_id === KIM);
    expect(kim.length).toBeGreaterThan(100);
    expect(mine.map(r => r.id)).toEqual(kim.map(r => r.id));
    expect(mine[0]).toEqual(S.SessionRow.strict().parse(mine[0]));
  });
  it('admin CSV returns all 250 sessions past a 100-row cap', async () => {
    const s = await setup({ sessions: 250, maxRows: 100 });
    const body = (await s.req('GET', '/api/admin/sessions.csv')).rawPayload.toString('utf8');
    expect(new Set(body.split('\r\n').filter(l => l.startsWith('"')).map(l => l.slice(1, 37)))).toEqual(new Set(s.t.sessions.map(r => r.id)));
  });
});

describe('GET /api/admin/sessions/:id (D-16)', () => {
  it('SessionDetail + state from progress, counts and the last trigger of the whole session', async () => {
    const s = await setup({ sessions: 4 }), row = s.t.sessions[3];
    const r = await s.req('GET', `/api/admin/sessions/${row.id}`);
    expect(r.statusCode).toBe(200);
    const d = S.AdminSessionDetail.parse(r.json());
    expect(d.state).toEqual({ mis: [0, 0], counts: { Eliciting: 3 }, goal_reached: false, last_trigger: 2 });
    expect(d.turns.map(x => x.seq)).toEqual([1, 2, 3]);
    expect([d.session.id, d.session.nickname, d.session.scenario_name, d.turn_limit]).toEqual([row.id, 'lee', 'Gabriel', 40]);
    expect((await s.req('GET', `/api/admin/sessions/${s.t.sessions[1].id}`)).json().state.last_trigger).toBeNull();
  });
  it('unknown id and a non-uuid id → 404', async () => {
    const s = await setup({ sessions: 1 });
    for (const id of [crypto.randomUUID(), 'nope']) expect((await s.req('GET', `/api/admin/sessions/${id}`)).json().error.code).toBe('not_found');
  });
});

describe('GET /api/admin/sessions.csv (G-26)', () => {
  it('streams text/csv as an attachment: BOM, header, every session newest first across pages, seq order, filters', async () => {
    const s = await setup({ sessions: 250 });
    const r = await s.req('GET', '/api/admin/sessions.csv');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(r.headers['content-disposition']).toBe('attachment; filename="sessions.csv"');
    expect([...r.rawPayload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const body = r.rawPayload.toString('utf8').slice(1);
    expect(body.startsWith('session_id,started_at,nickname,scenario,lang,seq,speaker,text,leverage,object,trigger\r\n"')).toBe(true);
    expect(body.endsWith('\r\n')).toBe(false);
    const ids = body.split('\r\n').slice(1).filter(l => l.startsWith('"')).map(l => l.slice(1, 37));
    expect(ids).toEqual(s.newest().flatMap(x => [x.id, x.id, x.id]));
    const first = s.newest()[0];
    expect(body).toContain([first.id, first.started_at, first.user_id === KIM ? 'kim' : 'lee'].map(v => `"${v}"`).join(','));
    expect(body).toContain(`"2","teacher","t${s.t.sessions.indexOf(first)} ""q""\r\nx","Eliciting","",""`);

    const lee = (await s.req('GET', `/api/admin/sessions.csv?user_id=${LEE}&scenario_id=${NOAH}`)).rawPayload.toString('utf8');
    expect(lee.split('\r\n').filter(l => /^"[0-9a-f-]{36}"/.test(l)).map(l => l.slice(1, 37)))
      .toEqual(s.newest().filter(x => x.user_id === LEE && x.scenario_id === NOAH).flatMap(x => [x.id, x.id, x.id]));
    expect((await s.req('GET', `/api/admin/sessions.csv?scenario_id=${crypto.randomUUID()}`)).rawPayload.toString('utf8'))
      .toBe('﻿session_id,started_at,nickname,scenario,lang,seq,speaker,text,leverage,object,trigger');
    expect((await s.req('GET', '/api/admin/sessions.csv?user_id=nope')).statusCode).toBe(400);
  });
  it('a failing first page is a normal 500 error body, not a broken CSV', async () => {
    const s = await setup({ sessions: 2, fail: t => t === 'sessions' });
    const r = await s.req('GET', '/api/admin/sessions.csv');
    expect([r.statusCode, r.json().error.code]).toEqual([500, 'internal']);
  });
});

// ---- AI 설정 (G-28, O-7): 목 updateAi 와 같은 입력 → 같은 결과·같은 오류·같은 감사 meta ----------------
const ANT = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123WXYZ', OAI = 'sk-proj-abcdefghijklmnopqrstuv9876', GEM = 'AIzaSyabcdefghijklmnopqrstuvwxyz012345GGGG';
type Step = [string, Record<string, unknown>];
const SCRIPT: Step[] = [
  ['analysis', { key_source: 'own', model: 'gpt-5.5', effort: 'max' }],                                   // 키 없음: enum 만
  ['student', { key_source: 'own', api_key: ANT, model: 'claude-haiku-5-5', effort: 'low' }],
  ['student', { key_source: 'own', model: 'claude-opus-5-5', effort: 'max' }],                            // 키 유지
  ['mentor', { key_source: 'student', model: 'claude-sonnet-5-5', effort: 'medium' }],                    // 공유
  ['analysis', { key_source: 'own', api_key: 'pk-unknown-0000000000', model: 'x', effort: null }],        // 접두어 모름
  ['analysis', { key_source: 'analysis', model: 'gpt-5.5', effort: null }],                               // 자기 자신
  ['analysis', { key_source: 'mentor', model: 'claude-opus-5-5', effort: null }],                         // 공유하는 역할의 키
  ['analysis', { key_source: 'student', api_key: OAI, model: 'gpt-5.5', effort: null }],                  // 키는 own 만
  ['teacher', { key_source: 'own', model: 'gpt-5.5', effort: null }],                                     // 없는 역할
  ['analysis', { key_source: 'own', api_key: OAI, model: 'gpt-6-astra', effort: 'low' }],
  ['analysis', { key_source: 'own', model: 'gpt-5.5', effort: 'max' }],                                   // invalid_effort: 목록 모델
  ['analysis', { key_source: 'own', model: 'gpt-6-astra', effort: 'none' }],
  ['analysis', { key_source: 'own', model: 'gpt-6.1-terra', effort: 'minimal' }],                         // 직접 입력: 공급자 집합
  ['analysis', { key_source: 'own', model: 'gpt-6.1-terra', effort: 'turbo' }],                           // enum 밖 = 400 validation
  ['analysis', { key_source: 'own', api_key: 'short', model: 'gpt-5.5', effort: null }],
  ['student', { key_source: 'own', api_key: GEM, model: 'gemini-4-argon', effort: 'low' }],               // 공유하던 mentor 의 공급자도 바뀐다
  ['student', { key_source: 'own', model: 'gemini-9-custom', effort: 'xhigh' }],
  ['student', { key_source: 'own', model: 'gemini-9-custom', effort: null }],                             // null 은 늘 통과
  ['student', { key_source: 'analysis', model: 'gpt-5.5', effort: 'high' }],                              // student 가 공유로: mentor 공급자 null
  ['mentor', { key_source: 'own', api_key: 'sk-plainopenai0000LAST', model: 'gpt-5.5', effort: null }],
];
type Outcome = { ok: unknown } | { error: [number, string, unknown] };

describe('AI settings = mock updateAi (G-28, O-7)', () => {
  it('the same script gives the same results, errors, final settings and ai.update audit meta as the mock', async () => {
    const m = mockTarget({ now: () => T0 }), mock = m.api('admin');
    await mock.adminLogin({ nickname: 'admin', password: ADMIN_PW });
    const s = await setup();
    for (const [role, body] of SCRIPT) {
      const want: Outcome = await mock.updateAiRole(role as 'student', body as never).then(ok => ({ ok }),
        (e: ApiError) => ({ error: [e.status, e.code, e.code === 'validation_failed' ? undefined : e.body.error.details] }));
      const r = await s.req('PUT', `/api/admin/ai/${role}`, body), j = r.json();
      const got: Outcome = r.statusCode === 200 ? { ok: j } : { error: [r.statusCode, j.error.code, j.error.code === 'validation_failed' ? undefined : j.error.details] };
      expect(got, `${role} ${JSON.stringify(body)}`).toEqual(want);
    }
    expect((await s.req('GET', '/api/admin/ai')).json()).toEqual(await mock.getAiSettings());
    const metas = (rows: Row[]) => rows.filter(a => a.action === 'ai.update').map(a => [a.target, a.meta]);
    expect(metas(s.t.audit_log)).toEqual(metas(m.store.db.audit_log));
    expect(s.t.audit_log.every(a => a.actor_id === ADMIN)).toBe(true);
  });

  it('one upsert per save; the key itself reaches neither the DB nor the audit log; key_ciphertext stays null and is never returned', async () => {
    const s = await setup();
    let saved = 0;
    for (const [role, body] of SCRIPT) saved += Number((await s.req('PUT', `/api/admin/ai/${role}`, body)).statusCode === 200);
    expect(saved).toBe(10);
    expect(s.calls.filter(c => c.startsWith('upsert'))).toHaveLength(saved);
    for (const role of ['constructor', '__proto__']) expect((await s.req('PUT', `/api/admin/ai/${role}`, SCRIPT[0][1])).statusCode).toBe(404);
    const json = JSON.stringify(s.t);
    for (const k of [ANT, OAI, GEM, 'sk-plainopenai0000LAST', 'pk-unknown-0000000000']) expect(json).not.toContain(k);
    expect(s.t.ai_settings.map(r => r.key_ciphertext)).toEqual([null, null, null]);
    const got = (await s.req('GET', '/api/admin/ai')).json();
    expect(S.AiSettings.parse(got)).toEqual(got);
    for (const r of Object.values(got)) expect(r).not.toHaveProperty('key_ciphertext');
  });

  it('GET /api/admin/ai/providers is the ProvidersFile parsed at startup', async () => {
    const s = await setup();
    expect((await s.req('GET', '/api/admin/ai/providers')).json()).toEqual(config.providers);
  });
});

describe('AI settings, MOCK_LLM=0: listModels check and key vault (Q5, Q6, Q23, Q32)', () => {
  const SECRET = Buffer.alloc(32, 9).toString('base64');
  const real = loadConfig({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'k', MOCK_LLM: '0', KEY_VAULT_SECRET: SECRET }, p => readFileSync(new URL(p, ROOT), 'utf8'));
  /** listModels 가 throw 하면 그 오류를, 아니면 2xx(목록은 버린다). */
  const fake = (fail?: () => Error) => {
    const calls: [string, string, unknown][] = [];
    const providersFor: ProvidersFor = (provider, key, opts) => {
      calls.push([provider, key, opts.role]);
      expect(typeof opts.log.info).toBe('function');
      return { id: provider, complete: () => { throw new Error('not in this ticket'); }, listModels: async () => { if (fail) throw fail(); return ['m']; } };
    };
    return { calls, providersFor };
  };
  const ANT_BODY = { key_source: 'own', api_key: ANT, model: 'claude-haiku-5-5', effort: 'low' };

  it('listModels throws 401 → 502 provider_rejected with status and a ≤200-char message summary; nothing is upserted or audited; the key is masked in the message', async () => {
    const f = fake(() => new AdapterError('anthropic', 'authentication_error', `invalid x-api-key ${ANT} ` + 'x'.repeat(300), { status: 401 }));
    const s = await setup({ config: real, providersFor: f.providersFor });
    const before = structuredClone(s.t.ai_settings);
    const r = await s.req('PUT', '/api/admin/ai/student', ANT_BODY), j = r.json();
    expect(r.statusCode).toBe(502);
    expect(j.error.code).toBe('provider_rejected');
    expect(j.error.details).toMatchObject({ status: 401, message: expect.stringMatching(/^invalid x-api-key /) });
    expect(j.error.details.message.length).toBeLessThanOrEqual(200);
    expect(r.body).not.toContain(ANT);
    expect(f.calls).toEqual([['anthropic', ANT, 'student']]);
    expect(s.calls.filter(c => c.startsWith('upsert') || c.startsWith('insert'))).toEqual([]);
    expect(s.t.ai_settings).toEqual(before);
  });

  it('a network error (no HTTP status) is provider_rejected too', async () => {
    const s = await setup({ config: real, providersFor: fake(() => new TypeError('fetch failed')).providersFor });
    const j = (await s.req('PUT', '/api/admin/ai/student', ANT_BODY)).json();
    expect(j.error).toMatchObject({ code: 'provider_rejected', details: { status: null, message: 'fetch failed' } });
    expect(s.calls.filter(c => c.startsWith('upsert'))).toEqual([]);
  });

  it('2xx → key_ciphertext is saved and opens back to the key; responses, GET and the audit meta never carry the key or the ciphertext', async () => {
    const f = fake(), s = await setup({ config: real, providersFor: f.providersFor });
    const r = await s.req('PUT', '/api/admin/ai/student', ANT_BODY);
    expect(r.statusCode).toBe(200);
    expect(f.calls).toEqual([['anthropic', ANT, 'student']]);
    const c = s.t.ai_settings.find(x => x.role === 'student')!.key_ciphertext as string;
    expect(open(c, SECRET)).toBe(ANT);
    expect(r.json()).not.toHaveProperty('key_ciphertext');
    expect(r.json()).toMatchObject({ provider: 'anthropic', key_masked: S.maskKey(ANT) });
    const got = (await s.req('GET', '/api/admin/ai')).json();
    for (const x of Object.values(got)) expect(x).not.toHaveProperty('key_ciphertext');
    expect(s.t.audit_log.map(a => a.meta)).toEqual([expect.objectContaining({ key_changed: true })]);
    for (const out of [r.body, JSON.stringify(got), JSON.stringify(s.t.audit_log)]) { expect(out).not.toContain(ANT); expect(out).not.toContain(c); }
  });

  it('saves without api_key never call providersFor and keep the ciphertext; switching to a shared key drops it', async () => {
    const f = fake(), s = await setup({ config: real, providersFor: f.providersFor });
    await s.req('PUT', '/api/admin/ai/student', ANT_BODY);
    const c = s.t.ai_settings.find(x => x.role === 'student')!.key_ciphertext;
    expect((await s.req('PUT', '/api/admin/ai/student', { key_source: 'own', model: 'claude-opus-5-5', effort: 'max' })).statusCode).toBe(200);
    expect(s.t.ai_settings.find(x => x.role === 'student')!.key_ciphertext).toBe(c);
    await s.req('PUT', '/api/admin/ai/analysis', { key_source: 'own', api_key: OAI, model: 'gpt-5.5', effort: null });
    expect((await s.req('PUT', '/api/admin/ai/student', { key_source: 'analysis', model: 'gpt-5.5', effort: null })).statusCode).toBe(200);
    expect(s.t.ai_settings.find(x => x.role === 'student')!.key_ciphertext).toBeNull();
    expect(f.calls.map(x => x[0])).toEqual(['anthropic', 'openai']);
  });

  it('validation errors are answered before any provider call', async () => {
    const f = fake(), s = await setup({ config: real, providersFor: f.providersFor });
    expect((await s.req('PUT', '/api/admin/ai/student', { ...ANT_BODY, effort: 'none' })).json().error.code).toBe('invalid_effort');
    expect((await s.req('PUT', '/api/admin/ai/student', { ...ANT_BODY, api_key: 'pk-unknown-0000000000' })).statusCode).toBe(400);
    expect(f.calls).toEqual([]);
  });

  it('MOCK_LLM=1 never calls providersFor and stores no ciphertext (stage-2 behaviour)', async () => {
    const f = fake(), s = await setup({ providersFor: f.providersFor });
    expect((await s.req('PUT', '/api/admin/ai/student', ANT_BODY)).statusCode).toBe(200);
    expect(f.calls).toEqual([]);
    expect(s.t.ai_settings.map(r => r.key_ciphertext)).toEqual([null, null, null]);
  });
});
