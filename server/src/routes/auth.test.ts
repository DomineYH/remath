// 인증 라우트 회귀 (C-8, C-12): 메모리 Data API 스텁으로 끼어들기 순서를 고정한다.
import { readFileSync } from 'node:fs';
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import type { Db } from '../db.ts';

type Row = Record<string, unknown>;
type Op = 'select' | 'insert' | 'update' | 'delete' | 'rpc';
interface Hooks { before?: (op: Op, table: string) => Promise<void> | void; fail?: (op: Op, table: string) => boolean }

/**
 * supabase-js 쿼리 빌더 중 routes/auth.ts·auth.ts 가 쓰는 부분만. 연산마다 한 번씩 await 지점이 있다.
 * rpc 는 0002_auth_atomic.sql 과 같은 규칙을 await 없이 한 번에 적용한다(= 한 트랜잭션).
 */
function fakeDb(t: Record<string, Row[]>, hooks: Hooks = {}) {
  const from = (table: string) => {
    let op: Op = 'select', values: Row = {}, mode: 'many' | 'one' | 'maybe' = 'many';
    const filters: ((r: Row) => boolean)[] = [];
    const run = async () => {
      await hooks.before?.(op, table);
      if (hooks.fail?.(op, table)) return { data: null, error: { code: 'XX000', message: 'injected failure' } };
      const rows = t[table] ??= [];
      let out: Row[];
      if (op === 'insert') {
        const r: Row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...values };
        if (table === 'users' && rows.some(u => String(u.nickname).toLowerCase() === String(r.nickname).toLowerCase())) return { data: null, error: { code: '23505', message: 'dup' } };
        rows.push(r); out = [r];
      } else {
        out = rows.filter(r => filters.every(f => f(r)));
        if (op === 'update') out.forEach(r => Object.assign(r, values));
        if (op === 'delete') t[table] = rows.filter(r => !out.includes(r));
        if (op === 'select' && table === 'auth_sessions') out = out.map(r => ({ ...r, user: t.users.find(u => u.id === r.user_id) }));
      }
      out = out.map(r => structuredClone(r));   // PostgREST answers with copies, never live rows
      const data = mode === 'many' ? out : out[0] ?? null;
      return mode === 'one' && !data ? { data: null, error: { code: 'PGRST116', message: 'no rows' } } : { data, error: null };
    };
    const b = {
      select: () => b, insert: (v: Row) => { op = 'insert'; values = v; return b; },
      update: (v: Row) => { op = 'update'; values = v; return b; }, delete: () => { op = 'delete'; return b; },
      eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return b; },
      neq: (c: string, v: unknown) => { filters.push(r => r[c] !== v); return b; },
      ilike: (c: string, p: string) => { const re = new RegExp('^' + p.replace(/\\_|_/g, m => m === '_' ? '.' : '_') + '$', 'i'); filters.push(r => re.test(String(r[c]))); return b; },
      single: () => { mode = 'one'; return b; }, maybeSingle: () => { mode = 'maybe'; return b; },
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => run().then(ok, ko),
    };
    return b;
  };
  const rpc = async (name: string, a: Row) => {
    await hooks.before?.('rpc', name);
    if (hooks.fail?.('rpc', name)) return { data: null, error: { code: 'XX000', message: 'injected failure' } };
    if (name === 'issue_session') {
      if (!t.users.some(u => u.id === a.p_user_id && u.password_hash === a.p_verified_hash && u.role === a.p_realm)) return { data: false, error: null };
      t.auth_sessions.push({ id: crypto.randomUUID(), user_id: a.p_user_id, realm: a.p_realm, token_hash: a.p_token_hash, expires_at: a.p_expires_at });
      return { data: true, error: null };
    }
    if (name === 'change_password') {
      const u = t.users.find(u => u.id === a.p_user_id && (a.p_expected_hash === null || u.password_hash === a.p_expected_hash));
      if (!u) return { data: false, error: null };
      Object.assign(u, { password_hash: a.p_new_hash, pw_updated_at: new Date().toISOString() });
      t.auth_sessions = t.auth_sessions.filter(r => r.user_id !== a.p_user_id || (a.p_keep_token_hash !== null && r.token_hash === a.p_keep_token_hash));
      return { data: true, error: null };
    }
    throw new Error(`unknown rpc ${name}`);
  };
  return { from, rpc } as unknown as Db;
}

/** 한 번만 멈추는 문: 도착을 알리고 release 까지 기다린다. */
function gate() {
  let arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>(r => { arrive = r; }), opened = new Promise<void>(r => { release = r; });
  return { arrived, release, wait: () => { arrive(); return opened; } };
}

const config = loadConfig({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'k', MOCK_LLM: '1' },
  p => readFileSync(new URL(p, new URL('../../../', import.meta.url)), 'utf8'));
const PW = 'abcd1234', NEXT = 'efgh5678', OTHER = 'ijkl9012';

async function setup(hooks: Hooks = {}) {
  const tables: Record<string, Row[]> = {
    users: [{ id: crypto.randomUUID(), nickname: 'Kim', role: 'teacher', password_hash: await argon2.hash(PW), pw_updated_at: new Date(Date.now() - 60_000).toISOString() }],
    auth_sessions: [], audit_log: [],
  };
  const app = await buildApp({ db: fakeDb(tables, hooks), config });
  const login = (password = PW) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { nickname: 'kim', password } });
  const cookieOf = (r: { cookies: { name: string; value: string }[] }) => r.cookies.find(c => c.name === 'remath_teacher')?.value;
  const me = (cookie: string | undefined) => app.inject({ url: '/api/auth/me', cookies: { remath_teacher: cookie ?? '' } }).then(r => r.statusCode);
  const change = (cookie: string | undefined, next = NEXT) => app.inject({ method: 'PUT', url: '/api/auth/password', cookies: { remath_teacher: cookie ?? '' }, payload: { current: PW, next } });
  return { tables, app, login, cookieOf, me, change };
}

describe('login failure lockout over HTTP (C-8, O-12)', () => {
  it('failures 1–4 are 401, the 5th is already 429 with retry_after, every attempt is audited', async () => {
    const s = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await s.login('wrong9999')).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 429, 429]);
    const fifth = await s.login('wrong9999');
    expect(fifth.json().error).toMatchObject({ code: 'too_many_attempts', details: { retry_after: 60 } });
    expect(s.tables.audit_log.map(a => (a.meta as Row).reason)).toEqual([
      ...Array(5).fill('invalid_credentials'), 'too_many_attempts', 'too_many_attempts']);
  });
});

/** 한 번 멈출 지점을 고르는 hooks: arm(op, name) 다음 그 연산 하나가 gate 에서 기다린다. */
function pausable(fail?: Hooks['fail']) {
  let armed: { op: Op; name: string; g: ReturnType<typeof gate> } | null = null;
  const hooks: Hooks = { fail, before: (op, name) => { if (armed && armed.op === op && armed.name === name) { const g = armed.g; armed = null; return g.wait(); } } };
  const arm = (op: Op, name: string) => { const g = gate(); armed = { op, name, g }; return g; };
  return { hooks, arm };
}

describe('password change ends every other login (C-12)', () => {
  it('keeps the current session as it is and ends the others; audited once', async () => {
    const s = await setup();
    const a = s.cookieOf(await s.login()), b = s.cookieOf(await s.login());
    const done = await s.change(a);
    expect(done.statusCode).toBe(204);
    expect(s.cookieOf(done)).toBeUndefined();     // no re-issue, no new cookie
    expect(await s.me(a)).toBe(200);
    expect(await s.me(b)).toBe(401);
    expect((await s.login(NEXT)).statusCode).toBe(200);
    expect(s.tables.audit_log.map(x => x.action)).toEqual(['auth.password_change']);
  });

  it('a login that verified the old password before the change gets no session: 401, no cookie, audited', async () => {
    const p = pausable(), s = await setup(p.hooks);
    const a = s.cookieOf(await s.login());
    const g = p.arm('rpc', 'issue_session');
    const late = s.login();                       // old hash verified, stops right before issue_session
    await g.arrived;
    expect((await s.change(a)).statusCode).toBe(204);
    g.release();
    const r = await late;
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('invalid_credentials');
    expect(s.cookieOf(r)).toBeUndefined();
    expect(s.tables.auth_sessions).toHaveLength(1);   // only the changer's own session
    expect((s.tables.audit_log.at(-1)!.meta as Row).reason).toBe('password_changed');
  });

  it('overlapping changes from two browsers: the later one is refused and changes nothing', async () => {
    const p = pausable(), s = await setup(p.hooks);
    const a = s.cookieOf(await s.login()), b = s.cookieOf(await s.login());
    const g = p.arm('rpc', 'change_password');
    const slow = s.change(a, NEXT);               // verified the old hash, stops right before its rpc
    await g.arrived;
    expect((await s.change(b, OTHER)).statusCode).toBe(204);
    g.release();
    const r = await slow;
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('invalid_credentials');
    expect(await s.me(b)).toBe(200);              // the change that won keeps its browser
    expect(await s.me(a)).toBe(401);              // and ended the other one
    expect((await s.login(OTHER)).statusCode).toBe(200);
    expect((await s.login(NEXT)).statusCode).toBe(401);
    expect(s.tables.audit_log.filter(x => x.action === 'auth.password_change')).toHaveLength(1);
  });

  it('a change that fails at the rpc is a 500 and changes nothing', async () => {
    const s = await setup({ fail: (op, name) => op === 'rpc' && name === 'change_password' });
    const a = s.cookieOf(await s.login()), b = s.cookieOf(await s.login());
    expect((await s.change(a)).statusCode).toBe(500);
    expect(await s.me(a)).toBe(200);
    expect(await s.me(b)).toBe(200);
    expect((await s.login()).statusCode).toBe(200);   // old password still valid
    expect(s.tables.audit_log.filter(x => x.action === 'auth.password_change')).toEqual([]);
  });

  it('a login whose session cannot be issued is a 500 with no cookie and no session row', async () => {
    const s = await setup({ fail: (op, name) => op === 'rpc' && name === 'issue_session' });
    const r = await s.login();
    expect(r.statusCode).toBe(500);
    expect(s.cookieOf(r)).toBeUndefined();
    expect(s.tables.auth_sessions).toEqual([]);
  });
});
