// T-3: 0005_turn_deadline.sql on PGlite after 0001–0004 (stage 2 review fix). record_turn now also refuses a turn whose claim
// is older than p_timeout_ms (GLOSSARY 턴 시간 제한): nothing is written and the claim stays, so the holder's release_turn
// still fences it. The token fence itself is 0003's and is covered there; here: deadline, signature, privileges.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

const file = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8');
const sql = file('0005_turn_deadline.sql');
const db = new PGlite();
const rows = async <T = Record<string, unknown>>(q: string, p?: unknown[]) => (await db.query<T>(q, p)).rows;
const one = async <T = Record<string, unknown>>(q: string, p?: unknown[]) => (await rows<T>(q, p))[0];
const FN = 'record_turn(uuid, uuid, integer, jsonb, jsonb, jsonb, boolean, timestamptz, jsonb)';
const OLD = 'record_turn(uuid, uuid, jsonb, jsonb, jsonb, boolean, timestamptz, jsonb)';

let sid: string;
beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  for (const f of ['0001_init.sql', '0002_auth_atomic.sql', '0003_start_session.sql', '0004_admin_atomic.sql']) await db.exec(file(f));
  await db.exec(sql);
  const u = (await one<{ id: string }>(`insert into users (nickname, password_hash) values ('kim', 'H') returning id`)).id;
  const sc = (await one<{ id: string }>(`insert into scenarios (slug) values ('s1') returning id`)).id;
  sid = (await one<{ id: string }>(`select start_session($1, $2, 'ko', '{"mis":[0]}', '{}', 'hi') as id`, [u, sc])).id;
}, 60_000);

describe('apply (D-15)', () => {
  it('records itself after 0004 and refuses a second run', async () => {
    expect((await rows<{ version: string }>('select version from schema_migrations order by version')).map(r => r.version))
      .toEqual(['0001', '0002', '0003', '0004', '0005']);
    await expect(db.exec(sql)).rejects.toThrow(/migration 0005 already applied/);
  });
  it('is a single psql file: no transaction control, ends with its schema_migrations row', () => {
    expect(sql.replace(/--.*$/gm, '')).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);
    expect(sql.trimEnd()).toMatch(/insert into schema_migrations \(version, name\) values \('0005', 'turn_deadline'\);$/);
  });
});

describe('privileges', () => {
  it('replaces the 0003 record_turn; runs as the caller with a fixed search_path', async () => {
    expect(await rows(`select oid::regprocedure::text as f from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_turn'`))
      .toEqual([{ f: FN.replace(/, /g, ',').replace('timestamptz', 'timestamp with time zone') }]);
    await expect(db.query(`select $1::regprocedure`, [OLD])).rejects.toThrow(/does not exist/);
    expect(await rows(`select prosecdef, proconfig from pg_proc where oid = $1::regprocedure`, [FN])).toEqual([{ prosecdef: false, proconfig: ['search_path=public'] }]);
  });
  it('PUBLIC, anon and authenticated cannot execute it; service_role can', async () => {
    expect(await rows(`select 1 from pg_proc, aclexplode(proacl) a where oid = $1::regprocedure and a.grantee = 0`, [FN])).toEqual([]);
    for (const role of ['anon', 'authenticated']) expect((await one<{ x: boolean }>(`select has_function_privilege($1, $2, 'execute') as x`, [role, FN])).x, role).toBe(false);
    expect((await one<{ x: boolean }>(`select has_function_privilege('service_role', $1, 'execute') as x`, [FN])).x).toBe(true);
  });
});

// ---- deadline (GLOSSARY 턴 시간 제한) ---------------------------------------------------------------
const A = '0000000a-0000-4000-8000-000000000000', B = '0000000b-0000-4000-8000-000000000000';
const claim = (token: string) => one(`select claim_turn($1, $2, 120000)`, [sid, token]);
const record = (token: string, timeoutMs: number, text: string) =>
  one<{ ok: boolean }>(`select record_turn($1, $2, $3, $4, '{"mis":[1]}', '{"Eliciting":1}', false, null, null) as ok`,
    [sid, token, timeoutMs, JSON.stringify([{ seq: 2, speaker: 'teacher', text }, { seq: 3, speaker: 'student', text: 's' }])]).then(r => r.ok);
const state = () => one<{ turn_claim: string | null; counts: unknown; teacher: string[] }>(
  `select turn_claim, counts, array(select text from turns where session_id = s.id and speaker = 'teacher') as teacher from sessions s where id = $1`, [sid]);
const reset = async () => {
  await db.query(`delete from turns where session_id = $1 and seq > 1`, [sid]);
  await db.query(`update sessions set turn_claim = null, turn_started_at = null, counts = '{}' where id = $1`, [sid]);
};

describe('record_turn deadline', () => {
  it('in time: writes the turns and state, clears the claim', async () => {
    await reset(); await claim(A);
    expect(await record(A, 120_000, 'in time')).toBe(true);
    expect(await state()).toEqual({ turn_claim: null, counts: { Eliciting: 1 }, teacher: ['in time'] });
  });
  it('past p_timeout_ms since the claim: false, nothing written, the claim stays so the holder can release it', async () => {
    await reset(); await claim(A);
    await db.query(`update sessions set turn_started_at = now() - interval '2 seconds' where id = $1`, [sid]);
    expect(await record(A, 1000, 'too late')).toBe(false);
    expect(await state()).toEqual({ turn_claim: A, counts: {}, teacher: [] });
    expect((await one<{ ok: boolean }>(`select release_turn($1, $2) as ok`, [sid, A])).ok).toBe(true);
  });
  it('the deadline is measured on the DB clock at write time, not at transaction start', async () => {
    await reset(); await claim(A);
    await db.exec('begin');
    try {
      await new Promise(r => setTimeout(r, 120));   // now() is frozen at begin; clock_timestamp() moves on
      expect(await record(A, 100, 'slow persistence')).toBe(false);
    } finally { await db.exec('commit'); }
    expect((await state()).teacher).toEqual([]);
  });
  it('a wrong token writes nothing, in time or not', async () => {
    await reset(); await claim(B);
    expect(await record(A, 120_000, 'stale')).toBe(false);
    expect(await state()).toEqual({ turn_claim: B, counts: {}, teacher: [] });
  });
});
