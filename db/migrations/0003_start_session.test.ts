// T-3: 0003_start_session.sql on PGlite after 0001 + 0002 (#42 rev 3). Session row and greeting turn are one call;
// sessions_one_active makes a second active start fail as a whole. Turns are fenced by a claim token: only the current
// holder of an unended session records or releases. PGlite is one connection, so row-lock waits are reasoned in the SQL comments.
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
const FNS = [FN, 'claim_turn(uuid, uuid, integer)', 'record_turn(uuid, uuid, jsonb, jsonb, jsonb, boolean, timestamptz, jsonb)', 'release_turn(uuid, uuid)'];

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
  it('every function runs as the caller with a fixed search_path; the 0001 turn functions are replaced', async () => {
    for (const f of FNS) expect(await rows(`select prosecdef, proconfig from pg_proc where oid = $1::regprocedure`, [f]), f)
      .toEqual([{ prosecdef: false, proconfig: ['search_path=public'] }]);
    expect((await rows(`select oid::regprocedure::text as f from pg_proc where pronamespace = 'public'::regnamespace and proname in ('claim_turn', 'record_turn')`)).length).toBe(2);
  });
  it('PUBLIC, anon and authenticated cannot execute them; service_role can', async () => {
    for (const f of FNS) {
      expect(await rows(`select 1 from pg_proc, aclexplode(proacl) a where oid = $1::regprocedure and a.grantee = 0`, [f]), f).toEqual([]);
      for (const role of ['anon', 'authenticated']) expect((await one<{ x: boolean }>(`select has_function_privilege($1, $2, 'execute') as x`, [role, f])).x, `${role} ${f}`).toBe(false);
      expect((await one<{ x: boolean }>(`select has_function_privilege('service_role', $1, 'execute') as x`, [f])).x, f).toBe(true);
    }
    for (const role of ['anon', 'authenticated']) {
      await expect(asRole(role, () => start(tch))).rejects.toThrow(/permission denied/);
      await expect(asRole(role, () => db.query(`select claim_turn(gen_random_uuid(), gen_random_uuid(), 1000)`))).rejects.toThrow(/permission denied/);
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

// ---- claim token fence (F-22·F-24) --------------------------------------------------------------
const A = '0000000a-0000-4000-8000-000000000000', B = '0000000b-0000-4000-8000-000000000000';
const claim = (sid: string, token: string, ms = 120_000) => one<{ ok: boolean }>(`select claim_turn($1, $2, $3) as ok`, [sid, token, ms]).then(r => r.ok);
const teacherTurn = (seq: number, text: string) => JSON.stringify([{ seq, speaker: 'teacher', text }, { seq: seq + 1, speaker: 'student', text: 's' }]);
const record = (sid: string, token: string, turns = '[]', end: { at: string | null; report: unknown } = { at: null, report: null }) =>
  one<{ ok: boolean }>(`select record_turn($1, $2, $3, '{"mis":[1,0]}', '{"Eliciting":1}', false, $4, $5) as ok`,
    [sid, token, turns, end.at, end.report === null ? null : JSON.stringify(end.report)]).then(r => r.ok);
const release = (sid: string, token: string) => db.query(`select release_turn($1, $2)`, [sid, token]);
const state = (sid: string) => one<{ turn_claim: string | null; started: boolean; ended: boolean; report: unknown; turns: number }>(
  `select turn_claim, turn_started_at is not null as started, ended_at is not null as ended, report, (select count(*)::int from turns where session_id = s.id) as turns
     from sessions s where id = $1`, [sid]);
const fresh = async () => { await db.query(`delete from sessions`); return start(tch); };

describe('claim token fence', () => {
  it('claim sets the token; a second claim loses while the first is live', async () => {
    const sid = await fresh();
    expect(await claim(sid, A)).toBe(true);
    expect(await claim(sid, B)).toBe(false);
    expect(await state(sid)).toMatchObject({ turn_claim: A, started: true });
  });
  it('the holder records once: turns inserted, state updated, claim cleared; a second record with the same token is refused', async () => {
    const sid = await fresh();
    await claim(sid, A);
    expect(await record(sid, A, teacherTurn(2, 'q'))).toBe(true);
    expect(await state(sid)).toMatchObject({ turn_claim: null, started: false, turns: 3 });
    expect(await one(`select progress, counts from sessions where id = $1`, [sid])).toEqual({ progress: { mis: [1, 0] }, counts: { Eliciting: 1 } });
    expect(await record(sid, A, teacherTurn(4, 'again'))).toBe(false);
    expect((await state(sid)).turns).toBe(3);
  });
  it('a stale token can neither record nor release; the current holder is untouched', async () => {
    const sid = await fresh();
    await claim(sid, B);
    expect(await record(sid, A, teacherTurn(2, 'stale'))).toBe(false);
    await release(sid, A);
    expect(await state(sid)).toMatchObject({ turn_claim: B, started: true, turns: 1 });
    await release(sid, B);
    expect(await state(sid)).toMatchObject({ turn_claim: null, started: false });
  });
  it('an ended session can be neither claimed nor recorded, even by the token that holds it', async () => {
    const sid = await fresh();
    await claim(sid, A);
    await db.query(`update sessions set ended_at = now() where id = $1`, [sid]);
    expect(await record(sid, A, teacherTurn(2, 'late'))).toBe(false);
    expect((await state(sid)).turns).toBe(1);
    await db.query(`update sessions set turn_claim = null, turn_started_at = null where id = $1`, [sid]);
    expect(await claim(sid, B)).toBe(false);
  });
  it('an orphan past the timeout is taken over; the old holder is then fenced off', async () => {
    const sid = await fresh();
    await claim(sid, A);
    await db.query(`update sessions set turn_started_at = now() - interval '2 seconds' where id = $1`, [sid]);
    expect(await claim(sid, B, 1000)).toBe(true);
    expect(await record(sid, A, teacherTurn(2, 'old'))).toBe(false);
    expect(await record(sid, B, teacherTurn(2, 'new'))).toBe(true);
    expect(await rows(`select text from turns where session_id = $1 and speaker = 'teacher'`, [sid])).toEqual([{ text: 'new' }]);
  });
  it('review case: a slow holder whose lease expired cannot reopen an end stored by the turn that took over', async () => {
    const sid = await fresh();
    expect(await claim(sid, A, 40)).toBe(true);                         // A claims and then stalls (slow context read)
    await new Promise(r => setTimeout(r, 80));
    expect(await claim(sid, B, 40)).toBe(true);                         // B takes over the expired lease and ends the session
    const report = { total: 0, reached: false, verdict: 'none', rows: [], summary: null };
    expect(await record(sid, B, '[]', { at: new Date().toISOString(), report })).toBe(true);
    expect(await record(sid, A, teacherTurn(2, 'resumed'))).toBe(false); // A resumes: fenced off
    expect(await state(sid)).toMatchObject({ ended: true, report, turn_claim: null, turns: 1 });
  });
});
