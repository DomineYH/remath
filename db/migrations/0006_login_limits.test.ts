// T-3: 0006_login_limits.sql on PGlite after 0001–0005 (V12). The login failure counter (C3) moves from process memory to
// login_limits, one row per (realm, lower(nickname)), so every server instance sees the same count. Each rpc is one atomic
// statement on the DB clock: login_check (retry_after or null), login_fail (record, then retry_after or null), login_reset.
// Time passing is simulated by moving last_fail_at back, as 0005's test moves turn_started_at.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const file = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8');
const sql = file('0006_login_limits.sql');
const db = new PGlite();
const rows = async <T = Record<string, unknown>>(q: string, p?: unknown[]) => (await db.query<T>(q, p)).rows;
const one = async <T = Record<string, unknown>>(q: string, p?: unknown[]) => (await rows<T>(q, p))[0];
const FNS = ['login_check(text, text)', 'login_fail(text, text)', 'login_reset(text, text)'];

beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  for (const f of ['0001_init.sql', '0002_auth_atomic.sql', '0003_start_session.sql', '0004_admin_atomic.sql', '0005_turn_deadline.sql']) await db.exec(file(f));
  await db.exec(sql);
}, 60_000);
beforeEach(() => db.exec('delete from login_limits'));

type Realm = 'teacher' | 'admin';
const check = (nick: string, realm: Realm = 'teacher') => one<{ r: number | null }>(`select login_check($1, $2) as r`, [realm, nick]).then(x => x.r);
const fail = (nick: string, realm: Realm = 'teacher') => one<{ r: number | null }>(`select login_fail($1, $2) as r`, [realm, nick]).then(x => x.r);
const reset = (nick: string, realm: Realm = 'teacher') => db.query(`select login_reset($1, $2)`, [realm, nick]);
const failN = async (n: number, nick = 'Kim', realm: Realm = 'teacher') => { for (let i = 0; i < n; i++) await fail(nick, realm); };
/** Every row's last failure moves `ms` into the past. */
const age = (ms: number) => db.query(`update login_limits set last_fail_at = last_fail_at - make_interval(secs => $1 / 1000.0)`, [ms]);
const count = () => rows<{ realm: string; nick: string; fails: number }>(`select realm, nick, fails from login_limits order by realm, nick`);

describe('apply (D-15)', () => {
  it('records itself after 0005 and refuses a second run', async () => {
    expect((await rows<{ version: string }>('select version from schema_migrations order by version')).map(r => r.version))
      .toEqual(['0001', '0002', '0003', '0004', '0005', '0006']);
    await expect(db.exec(sql)).rejects.toThrow(/migration 0006 already applied/);
  });
  it('is a single psql file: no transaction control, ends with its schema_migrations row', () => {
    expect(sql.replace(/--.*$/gm, '')).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);
    expect(sql.trimEnd()).toMatch(/insert into schema_migrations \(version, name\) values \('0006', 'login_limits'\);$/);
  });
});

describe('privileges', () => {
  it('the functions run as the caller with a fixed search_path', async () => {
    for (const f of FNS) expect(await rows(`select prosecdef, proconfig from pg_proc where oid = $1::regprocedure`, [f]), f).toEqual([{ prosecdef: false, proconfig: ['search_path=public'] }]);
  });
  it('PUBLIC, anon and authenticated cannot execute them; service_role can', async () => {
    for (const f of FNS) {
      expect(await rows(`select 1 from pg_proc, aclexplode(proacl) a where oid = $1::regprocedure and a.grantee = 0`, [f]), f).toEqual([]);
      for (const role of ['anon', 'authenticated']) expect((await one<{ x: boolean }>(`select has_function_privilege($1, $2, 'execute') as x`, [role, f])).x, `${role} ${f}`).toBe(false);
      expect((await one<{ x: boolean }>(`select has_function_privilege('service_role', $1, 'execute') as x`, [f])).x, f).toBe(true);
    }
  });
  it('login_limits has RLS on and no table privileges for anon/authenticated', async () => {
    expect((await one<{ r: boolean }>(`select relrowsecurity as r from pg_class where oid = 'login_limits'::regclass`)).r).toBe(true);
    for (const role of ['anon', 'authenticated']) for (const p of ['select', 'insert', 'update', 'delete'])
      expect((await one<{ x: boolean }>(`select has_table_privilege($1, 'login_limits', $2) as x`, [role, p])).x, `${role} ${p}`).toBe(false);
  });
});

describe('rule C3 (C-8, O-12)', () => {
  it('the 5th failure locks for 60 s from the last failure; retry_after is the remaining seconds, rounded up', async () => {
    for (let i = 1; i <= 4; i++) expect(await fail('Kim'), `fail ${i}`).toBeNull();
    expect(await check('Kim')).toBeNull();
    expect(await fail('Kim')).toBe(60);
    expect(await check('Kim')).toBe(60);
    await age(59_500);
    expect(await check('Kim')).toBe(1);
    await age(500);
    expect(await check('Kim')).toBeNull();
    expect(await fail('Kim')).toBeNull();   // after the lock the count starts again
    expect(await count()).toEqual([{ realm: 'teacher', nick: 'kim', fails: 1 }]);
  });
  it('more failures while locked keep it locked, 60 s from the newest one', async () => {
    await failN(5); await age(30_000);
    expect(await check('Kim')).toBe(30);
    expect(await fail('Kim')).toBe(60);
    expect(await check('Kim')).toBe(60);
  });
  it('failures 60 s or more apart do not add up', async () => {
    await failN(4); await age(60_000);
    expect(await fail('Kim')).toBeNull();
    expect(await check('Kim')).toBeNull();
    expect(await count()).toEqual([{ realm: 'teacher', nick: 'kim', fails: 1 }]);
  });
  it('failures less than 60 s apart do add up', async () => {
    await failN(4); await age(59_000);
    expect(await fail('Kim')).toBe(60);
  });
  it('the nickname is case-insensitive', async () => {
    await failN(3, 'Kim'); await failN(2, 'KIM');
    expect(await check('kim')).toBe(60);
  });
  it('realms are counted separately', async () => {
    await failN(5, 'admin', 'teacher');
    expect(await check('admin', 'admin')).toBeNull();
    expect(await check('admin', 'teacher')).toBe(60);
  });
  it('success resets the count (case-insensitive), only for that key', async () => {
    await failN(4, 'Kim'); await failN(4, 'Lee');
    await reset('kIM');
    expect(await fail('Kim')).toBeNull();
    expect(await check('Kim')).toBeNull();
    expect(await fail('Lee')).toBe(60);
  });
  it('an unknown key is not locked and resetting it is a no-op', async () => {
    expect(await check('nobody')).toBeNull();
    await reset('nobody');
    expect(await count()).toEqual([]);
  });
  it('a realm outside teacher/admin is refused', async () => {
    await expect(fail('Kim', 'none' as Realm)).rejects.toThrow(/check constraint/);
  });
});

describe('atomicity and growth', () => {
  it('parallel failures are each counted once', async () => {
    const results = await Promise.all(Array.from({ length: 7 }, () => fail('Kim')));
    expect(results.filter(r => r === null)).toHaveLength(4);
    expect(results.filter(r => r === 60)).toHaveLength(3);
    expect(await count()).toEqual([{ realm: 'teacher', nick: 'kim', fails: 7 }]);
  });
  it('each rpc is a single SQL statement, no read-then-write', async () => {
    for (const f of ['login_check', 'login_reset']) {
      const src = (await one<{ s: string }>(`select prosrc as s from pg_proc where proname = $1`, [f])).s;
      expect(src.replace(/--.*$/gm, '').trim().replace(/;$/, ''), f).not.toContain(';');
    }
  });
  it('a failure sweeps expired keys of other nicknames; live keys stay', async () => {
    await failN(2, 'Old1'); await failN(1, 'Old2', 'admin'); await age(60_000);
    await failN(1, 'Live');
    await fail('Kim');
    expect(await count()).toEqual([{ realm: 'teacher', nick: 'kim', fails: 1 }, { realm: 'teacher', nick: 'live', fails: 1 }]);
  });
});
