// T-3: 0001_init.sql on PGlite (Postgres 18 WASM). Ported from the ticket 11 check.mjs plus D-14 and E-18.
// PGlite has no Supabase roles, so beforeAll creates anon/authenticated/service_role and Supabase's default GRANTs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

const sql = readFileSync(join(import.meta.dirname, '0001_init.sql'), 'utf8');
const db = new PGlite();
const rows = async <T = Record<string, unknown>>(q: string, p?: unknown[]) => (await db.query<T>(q, p)).rows;
const one = async <T = Record<string, unknown>>(q: string, p?: unknown[]) => (await rows<T>(q, p))[0];
const asRole = async (role: string, fn: () => Promise<unknown>) => {
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
};
const TABLES = ['schema_migrations', 'users', 'groups', 'group_members', 'scenarios', 'scenario_translations',
  'group_scenarios', 'sessions', 'turns', 'auth_sessions', 'ai_settings', 'audit_log'];
const RECORD_TURN = 'record_turn(uuid, jsonb, jsonb, jsonb, boolean, timestamptz, jsonb)';
const CLAIM_TURN = 'claim_turn(uuid, integer)';
const compiled = { student: 's', analysis: null, mentor: 'm' };

let admin: string, tch: string, grp: string, visible: string;

beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  await db.exec(sql);
}, 60_000); // PGlite boots a WASM Postgres; under the full parallel suite that alone can pass the 10 s default

describe('apply (D-15)', () => {
  it('records itself and refuses a second run', async () => {
    expect(await rows('select version, name from schema_migrations')).toEqual([{ version: '0001', name: 'init' }]);
    await expect(db.exec(sql)).rejects.toThrow(/migration 0001 already applied/);
  });
  it('is a single psql file: no concurrently, no transaction control', () => {
    const code = sql.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\bconcurrently\b/i);
    expect(code).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);
    expect(sql.trimEnd()).toMatch(/insert into schema_migrations \(version, name\) values \('0001', 'init'\);$/);
  });
  it('drops sessions.summary and audit_log.updated_at with its trigger (D-13)', async () => {
    const cols = await rows(`select table_name || '.' || column_name as c from information_schema.columns
      where table_schema = 'public' and (table_name, column_name) in (('sessions', 'summary'), ('audit_log', 'updated_at'))`);
    expect(cols).toEqual([]);
    expect(await rows(`select tgname from pg_trigger where tgname = 'audit_log_updated_at'`)).toEqual([]);
  });
});

describe('sample rows and the teacher read path (ADR-0003)', () => {
  it('enforces nickname and single-admin uniqueness', async () => {
    admin = (await one<{ id: string }>(`insert into users (nickname, password_hash, role) values ('Admin', 'h', 'admin') returning id`)).id;
    tch = (await one<{ id: string }>(`insert into users (nickname, password_hash) values ('teacher1', 'h') returning id`)).id;
    await expect(db.exec(`insert into users (nickname, password_hash, role) values ('Admin2', 'h', 'admin')`)).rejects.toThrow(/users_single_admin/);
    await expect(db.exec(`insert into users (nickname, password_hash) values ('TEACHER1', 'h')`)).rejects.toThrow(/users_nickname_key/);
  });

  it('teacher_scenarios returns published and assigned only, once, active-lang edition, no server-only columns', async () => {
    grp = (await one<{ id: string }>(`insert into groups (name) values ('g1') returning id`)).id;
    const grp2 = (await one<{ id: string }>(`insert into groups (name) values ('g2') returning id`)).id;
    await db.query(`insert into group_members values ($1, $2), ($3, $2)`, [grp, tch, grp2]);
    const mk = async (slug: string, status: string, groups: string[]) => {
      const { id } = await one<{ id: string }>(`insert into scenarios (slug, status, lang, compiled_prompt) values ($1, $2, 'ko', $3) returning id`,
        [slug, status, status === 'published' ? compiled : null]);
      await db.query(`insert into scenario_translations (scenario_id, lang, name, misconceptions)
        values ($1, 'ko', $2, '[{"kw":"왜","h":"음","c":"아"}]'), ($1, 'en', $3, '[]')`, [id, slug + '-ko', slug + '-en']);
      for (const g of groups) await db.query(`insert into group_scenarios values ($1, $2)`, [g, id]);
      return id;
    };
    visible = await mk('a-visible', 'published', [grp, grp2]); // assigned through two groups: still one row
    await mk('b-draft', 'draft', [grp]);
    await mk('c-unassigned', 'published', []);
    await expect(db.exec(`insert into scenarios (slug, status) values ('bad', 'published')`)).rejects.toThrow(/check constraint/);

    const mine = await rows(`select * from teacher_scenarios($1)`, [tch]);
    expect(mine.map(r => [r.id, r.name])).toEqual([[visible, 'a-visible-ko']]);
    for (const col of ['internal', 'compiled_prompt', 'misconceptions', 'aha', 't1', 'confused']) expect(mine[0]).not.toHaveProperty(col);
    expect(await rows(`select * from teacher_scenarios($1)`, [admin])).toEqual([]);
  });
});

describe('sessions and turns', () => {
  let ses: string;
  it('keeps one active session per user (D-14)', async () => {
    ses = (await one<{ id: string }>(`insert into sessions (user_id, scenario_id, lang, created_at, updated_at)
      values ($1, $2, 'ko', now() - interval '1 minute', now() - interval '1 minute') returning id`, [tch, visible])).id;
    await expect(db.query(`insert into sessions (user_id, scenario_id, lang) values ($1, $2, 'ko')`, [tch, visible]))
      .rejects.toThrow(/sessions_one_active/);
    await db.query(`insert into sessions (user_id, scenario_id, lang) values ($1, $2, 'ko')`, [admin, visible]); // other user: fine
  });

  it('enforces turn constraints and scenario delete restrict', async () => {
    await db.query(`insert into turns (session_id, seq, speaker, text, leverage) values ($1, 1, 'student', '안녕', null)`, [ses]);
    await expect(db.query(`insert into turns (session_id, seq, speaker, text) values ($1, 1, 'mentor', 'x')`, [ses])).rejects.toThrow(/turns_session_id_seq_key/);
    await expect(db.query(`insert into turns (session_id, seq, speaker, text, trigger) values ($1, 9, 'mentor', 'x', 4)`, [ses])).rejects.toThrow(/check constraint/);
    await expect(db.query(`delete from scenarios where id = $1`, [visible])).rejects.toThrow(/violates RESTRICT setting of foreign key/);
  });

  it('claim_turn: first wins, second loses, an orphan past timeout_ms is reclaimed (E-18)', async () => {
    const claim = async (ms: number) => (await one<{ ok: boolean }>(`select claim_turn($1, $2) as ok`, [ses, ms])).ok;
    expect(await claim(60_000)).toBe(true);
    expect(await claim(60_000)).toBe(false);
    await db.query(`update sessions set turn_started_at = now() - interval '2 seconds' where id = $1`, [ses]);
    expect(await claim(60_000)).toBe(false); // 2 s old, timeout 60 s: still in progress
    expect(await claim(1_000)).toBe(true);   // 2 s old, timeout 1 s: orphan
    expect((await one<{ fresh: boolean }>(`select turn_started_at > now() - interval '1 second' as fresh from sessions where id = $1`, [ses])).fresh).toBe(true);
  });

  const snapshot = async () => ({
    session: await one(`select progress, counts, goal_reached, ended_at, report, turn_started_at from sessions where id = $1`, [ses]),
    turns: await rows(`select seq, speaker, text, leverage, object, trigger from turns where session_id = $1 order by seq`, [ses]),
  });
  const record = (turns: unknown[], endedAt: string | null = null, report: unknown = null) =>
    db.query(`select record_turn($1, $2, $3, $4, $5, $6, $7)`,
      [ses, JSON.stringify(turns), { mis: [1] }, { Eliciting: 1 }, true, endedAt, report]);

  it('record_turn: a failing row leaves turns and session untouched', async () => {
    const before = await snapshot();
    expect(before.session.turn_started_at).not.toBeNull();
    await expect(record([
      { seq: 2, speaker: 'teacher', text: '왜?', leverage: 'Eliciting', object: null, trigger: null },
      { seq: 1, speaker: 'student', text: 'dup', leverage: null, object: null, trigger: null }, // seq 1 exists
    ])).rejects.toThrow(/turns_session_id_seq_key/);
    expect(await snapshot()).toEqual(before);
  });

  it('record_turn: inserts the turns and updates the session state in one call', async () => {
    await record([
      { seq: 2, speaker: 'teacher', text: '왜?', leverage: 'Eliciting', object: 'Reasoning' },
      { seq: 3, speaker: 'student', text: '음', leverage: null, object: null, trigger: null },
      { seq: 4, speaker: 'mentor', text: '좋아요', trigger: 3 },
    ]);
    const after = await snapshot();
    expect(after.turns.slice(1)).toEqual([
      { seq: 2, speaker: 'teacher', text: '왜?', leverage: 'Eliciting', object: 'Reasoning', trigger: null },
      { seq: 3, speaker: 'student', text: '음', leverage: null, object: null, trigger: null },
      { seq: 4, speaker: 'mentor', text: '좋아요', leverage: null, object: null, trigger: 3 },
    ]);
    expect(after.session).toEqual({ progress: { mis: [1] }, counts: { Eliciting: 1 }, goal_reached: true, ended_at: null, report: null, turn_started_at: null });
    expect((await one<{ ok: boolean }>(`select updated_at > created_at as ok from sessions where id = $1`, [ses])).ok).toBe(true);
  });

  it('record_turn: an end turn writes no turns, only ended_at and report; then a new session may start', async () => {
    const ended = '2026-10-28T01:00:00.000Z';
    await record([], ended, { summary: 'done' });
    const after = await snapshot();
    expect(after.turns).toHaveLength(4);
    expect(after.session).toMatchObject({ ended_at: new Date(ended), report: { summary: 'done' } });
    await db.query(`insert into sessions (user_id, scenario_id, lang) values ($1, $2, 'en')`, [tch, visible]);
  });

  it('cascades a user delete to sessions and turns (USR-1)', async () => {
    await db.query(`delete from users where id = $1`, [tch]);
    expect((await one<{ n: number }>(`select count(*)::int as n from turns`)).n).toBe(0);
  });
});

describe('RLS second line: anon/authenticated get nothing (ADR-0003)', () => {
  it('every table has RLS on and zero policies', async () => {
    const t = await rows<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`);
    expect(t.map(r => r.relname)).toEqual([...TABLES].sort());
    expect(t.every(r => r.relrowsecurity)).toBe(true);
    expect(await rows(`select policyname from pg_policies where schemaname = 'public'`)).toEqual([]);
  });

  it('anon/authenticated hold no schema, table, view or function privilege; service_role keeps EXECUTE', async () => {
    for (const role of ['anon', 'authenticated']) {
      // No direct schema grant. PG15+ still gives PUBLIC usage on `public`, so object privileges below are what keep anon out.
      expect(await rows(`select 1 from pg_namespace, aclexplode(nspacl) a where nspname = 'public' and a.grantee = $1::regrole`, [role])).toEqual([]);
      const tbl = await rows(`select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v')
        and (has_table_privilege($1, c.oid, 'select,insert,update,delete,truncate,references,trigger'))`, [role]);
      expect(tbl, role).toEqual([]);
      const fn = await rows(`select p.oid::regprocedure::text as f from pg_proc p
        where p.pronamespace = 'public'::regnamespace and has_function_privilege($1, p.oid, 'execute')`, [role]);
      expect(fn, role).toEqual([]);
    }
    for (const f of [RECORD_TURN, CLAIM_TURN]) {
      expect((await one<{ x: boolean }>(`select has_function_privilege('service_role', $1, 'execute') as x`, [f])).x, f).toBe(true);
    }
  });

  it('the three RPC/query functions run as the caller (security invoker) with a fixed search_path; the view is security_invoker', async () => {
    const fns = await rows<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(`select proname, prosecdef, proconfig
      from pg_proc where pronamespace = 'public'::regnamespace and proname in ('teacher_scenarios', 'record_turn', 'claim_turn') order by proname`);
    expect(fns).toEqual(['claim_turn', 'record_turn', 'teacher_scenarios'].map(proname =>
      ({ proname, prosecdef: false, proconfig: ['search_path=public'] })));
    expect((await one<{ o: string[] }>(`select reloptions as o from pg_class where oid = 'scenarios_public'::regclass`)).o)
      .toEqual(['security_invoker=true']);
  });

  it('denies every read and call, including objects created later', async () => {
    await db.exec(`create table later (x int); create sequence later_seq; create function later_fn() returns int language sql as 'select 1'`);
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) {
        expect((await one<{ x: boolean }>(`select has_table_privilege($1, 'later', $2) as x`, [role, priv])).x, `${role} ${priv} on later`).toBe(false);
      }
      for (const priv of ['usage', 'select', 'update']) {
        expect((await one<{ x: boolean }>(`select has_sequence_privilege($1, 'later_seq', $2) as x`, [role, priv])).x, `${role} ${priv} on later_seq`).toBe(false);
      }
    }
    const sid = (await one<{ id: string }>(`select id from sessions limit 1`)).id;
    for (const role of ['anon', 'authenticated']) {
      for (const q of ['select * from scenarios', 'select * from scenarios_public', `select * from teacher_scenarios('${admin}')`,
        'select * from ai_settings', 'select * from later', 'insert into later values (1)', "select nextval('later_seq')", 'select later_fn()', `select claim_turn('${sid}', 1000)`,
        `select record_turn('${sid}', '[]', '{}', '{}', false, null, null)`]) {
        await expect(asRole(role, () => db.exec(q)), `${role}: ${q}`).rejects.toThrow(/permission denied/);
      }
    }
  });

  it('service_role bypasses RLS with zero policies', async () => {
    const n = await asRole('service_role', () => one<{ n: number }>(`select count(*)::int as n from scenarios`));
    expect(n).toEqual({ n: 3 });
  });
});
