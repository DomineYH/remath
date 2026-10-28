// 인증 라우트 회귀 (C-8, C-12): 메모리 Data API 스텁으로 끼어들기 순서를 고정한다.
import { readFileSync } from 'node:fs';
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import type { Db } from '../db.ts';

type Row = Record<string, unknown>;
type Op = 'select' | 'insert' | 'update' | 'delete';
interface Hooks { before?: (op: Op, table: string) => Promise<void> | void; fail?: (op: Op, table: string) => boolean }

/** supabase-js 쿼리 빌더 중 routes/auth.ts·auth.ts 가 쓰는 부분만. 연산마다 한 번씩 await 지점이 있다. */
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
  return { from } as unknown as Db;
}

/** 한 번만 멈추는 문: 도착을 알리고 release 까지 기다린다. */
function gate() {
  let arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>(r => { arrive = r; }), opened = new Promise<void>(r => { release = r; });
  return { arrived, release, wait: () => { arrive(); return opened; } };
}

const config = loadConfig({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'k', MOCK_LLM: '1' },
  p => readFileSync(new URL(p, new URL('../../../', import.meta.url)), 'utf8'));
const PW = 'abcd1234', NEXT = 'efgh5678';

async function setup(hooks: Hooks = {}) {
  const tables: Record<string, Row[]> = {
    users: [{ id: crypto.randomUUID(), nickname: 'Kim', role: 'teacher', password_hash: await argon2.hash(PW), pw_updated_at: new Date(Date.now() - 60_000).toISOString() }],
    auth_sessions: [], audit_log: [],
  };
  const app = await buildApp({ db: fakeDb(tables, hooks), config });
  const login = (password = PW) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { nickname: 'kim', password } });
  const cookieOf = (r: { cookies: { name: string; value: string }[] }) => r.cookies.find(c => c.name === 'remath_teacher')?.value;
  const me = (cookie: string | undefined) => app.inject({ url: '/api/auth/me', cookies: { remath_teacher: cookie ?? '' } }).then(r => r.statusCode);
  const change = (cookie: string | undefined) => app.inject({ method: 'PUT', url: '/api/auth/password', cookies: { remath_teacher: cookie ?? '' }, payload: { current: PW, next: NEXT } });
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

describe('password change ends every other login (C-12)', () => {
  it('a login that verified the old password and issues its session after the change gets 401 and no cookie', async () => {
    let g: ReturnType<typeof gate> | null = null;
    const s = await setup({ before: (op, table) => { if (g && op === 'insert' && table === 'auth_sessions') { const x = g; g = null; return x.wait(); } } });
    const a = s.cookieOf(await s.login());
    g = gate(); const paused = g;
    const late = s.login();                       // verifies the old hash, then stops at its session insert
    await paused.arrived;
    expect((await s.change(a)).statusCode).toBe(204);
    paused.release();
    const r = await late;
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('invalid_credentials');
    expect(s.cookieOf(r)).toBeUndefined();
  });

  it('a login that completes while the change is in flight cannot outlive it, even when revocation fails', async () => {
    let g: ReturnType<typeof gate> | null = null;
    const s = await setup({
      before: (op, table) => { if (g && op === 'update' && table === 'users') { const x = g; g = null; return x.wait(); } },
      fail: (op, table) => op === 'delete' && table === 'auth_sessions',
    });
    const a = s.cookieOf(await s.login());
    g = gate(); const paused = g;
    const changing = s.change(a);                 // stops right before replacing the hash
    await paused.arrived;
    const b = s.cookieOf(await s.login());        // old password still valid at this instant
    expect(await s.me(b)).toBe(200);
    paused.release();
    const done = await changing;
    expect(done.statusCode).toBe(204);
    expect(await s.me(b)).toBe(401);
    expect(await s.me(a)).toBe(401);              // the old token of the current browser is replaced …
    expect(await s.me(s.cookieOf(done))).toBe(200); // … by the re-issued one, so this browser stays logged in
  });

  it('if deleting the other sessions fails, they still stop working and the change is not a 500', async () => {
    const s = await setup({ fail: (op, table) => op === 'delete' && table === 'auth_sessions' });
    const a = s.cookieOf(await s.login()), b = s.cookieOf(await s.login());
    const done = await s.change(a);
    expect(done.statusCode).toBe(204);
    expect(await s.me(b)).toBe(401);
    expect(await s.me(s.cookieOf(done))).toBe(200);
    expect(s.tables.audit_log.map(x => x.action)).toEqual(['auth.password_change']);
  });
});
