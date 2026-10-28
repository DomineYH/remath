// T-3: 0003_start_session.sql on PGlite after 0001 + 0002 (#42 rev 2). Session row and greeting turn are one call;
// sessions_one_active makes a second active start fail as a whole.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

const file = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8');
const sql = file('0003_start_session.sql');
const db = new PGlite();
const rows = async <T = Record<string, unknown>>(q: string, p?: unknown[]) => (await db.query<T>(q, p)).rows;
const one = async <T = Record<string, unknown>>(q: string, p?: unknown[]) => (await rows<T>(q, p))[0];
const asRole = async (role: string, fn: () => Promise<unknown>) => {
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
};
const FN = 'start_session(uuid, uuid, text, jsonb, jsonb, text)';

let tch: string, other: string, sc: string;
const start = (user: string, scenario = sc, greet = '안녕하세요') =>
  one<{ id: string }>(`select start_session($1, $2, 'ko', '{"mis":[0,0]}', '{}', $3) as id`, [user, scenario, greet]).then(r => r.id);
const count = (table: string, user: string) => one<{ n: number }>(
  table === 'sessions' ? `select count(*)::int as n from sessions where user_id = $1` : `select count(*)::int as n from turns t join sessions s on s.id = t.session_id where s.user_id = $1`, [user]).then(r => r.n);

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
  tch = (await one<{ id: string }>(`insert into users (nickname, password_hash) values ('kim', 'H') returning id`)).id;
  other = (await one<{ id: string }>(`insert into users (nickname, password_hash) values ('lee', 'H') returning id`)).id;
  sc = (await one<{ id: string }>(`insert into scenarios (slug) values ('s1') returning id`)).id;
}, 60_000);

describe('apply (D-15)', () => {
  it('records itself after 0002 and refuses a second run', async () => {
    expect(await rows('select version, name from schema_migrations order by version')).toEqual([
      { version: '0001', name: 'init' }, { version: '0002', name: 'auth_atomic' }, { version: '0003', name: 'start_session' }]);
    await expect(db.exec(sql)).rejects.toThrow(/migration 0003 already applied/);
  });
  it('is a single psql file: no concurrently, no transaction control', () => {
    const code = sql.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\bconcurrently\b/i);
    expect(code).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);
    expect(sql.trimEnd()).toMatch(/insert into schema_migrations \(version, name\) values \('0003', 'start_session'\);$/);
  });
});

describe('privileges', () => {
  it('runs as the caller with a fixed search_path', async () => {
    expect(await rows(`select prosecdef, proconfig from pg_proc where oid = $1::regprocedure`, [FN]))
      .toEqual([{ prosecdef: false, proconfig: ['search_path=public'] }]);
  });
  it('PUBLIC, anon and authenticated cannot execute it; service_role can', async () => {
    expect(await rows(`select 1 from pg_proc, aclexplode(proacl) a where oid = $1::regprocedure and a.grantee = 0`, [FN])).toEqual([]);
    for (const role of ['anon', 'authenticated']) {
      expect((await one<{ x: boolean }>(`select has_function_privilege($1, $2, 'execute') as x`, [role, FN])).x, role).toBe(false);
      await expect(asRole(role, () => start(tch))).rejects.toThrow(/permission denied/);
    }
    const id = await asRole('service_role', () => start(other)) as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await db.query(`delete from sessions`);
  });
});

describe('start_session: session and greeting in one call', () => {
  it('creates the session with the given lang/progress/counts and the seq-1 student greeting', async () => {
    const id = await start(tch);
    expect(await one(`select user_id, scenario_id, lang, progress, counts, ended_at, turn_started_at from sessions where id = $1`, [id]))
      .toEqual({ user_id: tch, scenario_id: sc, lang: 'ko', progress: { mis: [0, 0] }, counts: {}, ended_at: null, turn_started_at: null });
    expect(await rows(`select seq, speaker, text, leverage, object, trigger from turns where session_id = $1`, [id]))
      .toEqual([{ seq: 1, speaker: 'student', text: '안녕하세요', leverage: null, object: null, trigger: null }]);
  });
  it('a second active start for the same user fails with 23505 and leaves no row behind', async () => {
    await expect(start(tch)).rejects.toMatchObject({ code: '23505' });
    expect(await count('sessions', tch)).toBe(1);
    expect(await count('turns', tch)).toBe(1);
  });
  it('a greeting that cannot be inserted rolls the session back too', async () => {
    await expect(start(other, sc, null as unknown as string)).rejects.toMatchObject({ code: '23502' });   // turns.text not null
    expect(await count('sessions', other)).toBe(0);
  });
  it('after the active session ends, a new one can start', async () => {
    await db.query(`update sessions set ended_at = now() where user_id = $1`, [tch]);
    await start(tch);
    expect(await count('sessions', tch)).toBe(2);
    expect(await count('turns', tch)).toBe(2);
  });
});
