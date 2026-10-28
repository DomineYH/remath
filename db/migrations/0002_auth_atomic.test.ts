// T-3: 0002_auth_atomic.sql on PGlite after 0001 (#40 rev 3). PGlite is one connection, so the FOR SHARE / row-lock
// serialization between issue_session and change_password is reasoned (see the SQL comments), not executed here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

const file = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8');
const sql = file('0002_auth_atomic.sql');
const db = new PGlite();
const rows = async <T = Record<string, unknown>>(q: string, p?: unknown[]) => (await db.query<T>(q, p)).rows;
const one = async <T = Record<string, unknown>>(q: string, p?: unknown[]) => (await rows<T>(q, p))[0];
const asRole = async (role: string, fn: () => Promise<unknown>) => {
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
};
const ISSUE = 'issue_session(uuid, text, text, text, timestamptz)';
const CHANGE = 'change_password(uuid, text, text, text)';
const LATER = `now() + interval '1 day'`;

let tch: string, adm: string;
const issue = (user: string, hash: string, realm: string, token: string) =>
  one<{ ok: boolean }>(`select issue_session($1, $2, $3, $4, ${LATER}) as ok`, [user, hash, realm, token]).then(r => r.ok);
const change = (user: string, expected: string | null, next: string, keep: string | null) =>
  one<{ ok: boolean }>(`select change_password($1, $2, $3, $4) as ok`, [user, expected, next, keep]).then(r => r.ok);
const tokens = (user: string) => rows<{ token_hash: string }>(`select token_hash from auth_sessions where user_id = $1 order by token_hash`, [user])
  .then(r => r.map(x => x.token_hash));
const hashOf = (user: string) => one<{ h: string }>(`select password_hash as h from users where id = $1`, [user]).then(r => r.h);

beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  await db.exec(file('0001_init.sql'));
  await db.exec(sql);
  tch = (await one<{ id: string }>(`insert into users (nickname, password_hash) values ('kim', 'H0') returning id`)).id;
  adm = (await one<{ id: string }>(`insert into users (nickname, password_hash, role) values ('admin', 'A0', 'admin') returning id`)).id;
}, 60_000);

describe('apply (D-15)', () => {
  it('records itself after 0001 and refuses a second run', async () => {
    expect(await rows('select version, name from schema_migrations order by version'))
      .toEqual([{ version: '0001', name: 'init' }, { version: '0002', name: 'auth_atomic' }]);
    await expect(db.exec(sql)).rejects.toThrow(/migration 0002 already applied/);
  });
  it('is a single psql file: no concurrently, no transaction control', () => {
    const code = sql.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\bconcurrently\b/i);
    expect(code).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);
    expect(sql.trimEnd()).toMatch(/insert into schema_migrations \(version, name\) values \('0002', 'auth_atomic'\);$/);
  });
});

describe('privileges', () => {
  it('both functions run as the caller with a fixed search_path', async () => {
    const fns = await rows(`select proname, prosecdef, proconfig from pg_proc
      where pronamespace = 'public'::regnamespace and proname in ('issue_session', 'change_password') order by proname`);
    expect(fns).toEqual(['change_password', 'issue_session'].map(proname => ({ proname, prosecdef: false, proconfig: ['search_path=public'] })));
  });
  it('PUBLIC, anon and authenticated cannot execute them; service_role can', async () => {
    for (const f of [ISSUE, CHANGE]) {
      expect(await rows(`select 1 from pg_proc, aclexplode(proacl) a where oid = $1::regprocedure and a.grantee = 0`, [f]), f).toEqual([]);
      for (const role of ['anon', 'authenticated']) {
        expect((await one<{ x: boolean }>(`select has_function_privilege($1, $2, 'execute') as x`, [role, f])).x, `${role} ${f}`).toBe(false);
      }
      expect((await one<{ x: boolean }>(`select has_function_privilege('service_role', $1, 'execute') as x`, [f])).x, f).toBe(true);
    }
    for (const role of ['anon', 'authenticated']) {
      await expect(asRole(role, () => db.query(`select issue_session($1, 'H0', 'teacher', 'x', ${LATER})`, [tch]))).rejects.toThrow(/permission denied/);
      await expect(asRole(role, () => db.query(`select change_password($1, null, 'X', null)`, [tch]))).rejects.toThrow(/permission denied/);
    }
    expect(await asRole('service_role', () => issue(tch, 'H0', 'teacher', 'svc'))).toBe(true);
    await db.query(`delete from auth_sessions`);
  });
});

describe('issue_session: a session only for the password hash that was verified', () => {
  it('inserts the row when hash and realm match', async () => {
    expect(await issue(tch, 'H0', 'teacher', 't1')).toBe(true);
    expect(await one(`select realm, expires_at > now() as live from auth_sessions where token_hash = 't1'`)).toEqual({ realm: 'teacher', live: true });
  });
  it('returns false and inserts nothing for a stale hash or a realm that is not the role', async () => {
    expect(await issue(tch, 'H-old', 'teacher', 'stale')).toBe(false);
    expect(await issue(tch, 'H0', 'admin', 'wrong-realm')).toBe(false);
    expect(await issue(adm, 'A0', 'teacher', 'wrong-realm-2')).toBe(false);
    expect(await issue('00000000-0000-0000-0000-000000000000', 'H0', 'teacher', 'nobody')).toBe(false);
    expect(await tokens(tch)).toEqual(['t1']);
    expect(await tokens(adm)).toEqual([]);
  });
});

describe('change_password: replace the hash and end the other sessions in one call', () => {
  it('a stale expected hash changes nothing', async () => {
    await issue(tch, 'H0', 'teacher', 't2');
    const before = await one(`select password_hash, pw_updated_at from users where id = $1`, [tch]);
    expect(await change(tch, 'H-old', 'H1', 't1')).toBe(false);
    expect(await one(`select password_hash, pw_updated_at from users where id = $1`, [tch])).toEqual(before);
    expect(await tokens(tch)).toEqual(['t1', 't2']);
  });
  it('a matching hash replaces it, moves pw_updated_at and keeps only the named token', async () => {
    const before = (await one<{ t: Date }>(`select pw_updated_at as t from users where id = $1`, [tch])).t;
    expect(await change(tch, 'H0', 'H1', 't1')).toBe(true);
    expect(await hashOf(tch)).toBe('H1');
    expect((await one<{ t: Date }>(`select pw_updated_at as t from users where id = $1`, [tch])).t.getTime()).toBeGreaterThan(before.getTime());
    expect(await tokens(tch)).toEqual(['t1']);
    expect(await issue(tch, 'H0', 'teacher', 'late')).toBe(false);   // a login that verified the old hash gets no session
  });
  it('null keep ends every session; other users are untouched', async () => {
    await issue(adm, 'A0', 'admin', 'a1');
    expect(await change(tch, 'H1', 'H2', null)).toBe(true);
    expect(await tokens(tch)).toEqual([]);
    expect(await tokens(adm)).toEqual(['a1']);
  });
  it('null expected is an unconditional reset (#43, #45)', async () => {
    await issue(tch, 'H2', 'teacher', 't3');
    expect(await change(tch, null, 'H3', null)).toBe(true);
    expect(await hashOf(tch)).toBe('H3');
    expect(await tokens(tch)).toEqual([]);
  });
});
