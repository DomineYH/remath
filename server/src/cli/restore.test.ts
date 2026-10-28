// 복구 3단계 (H-31, O-5 A, T-1 e): SQLite 백업 → COPY 텍스트 → 한 트랜잭션. PGlite 에 마이그레이션 0001~를 올려 실제로 넣어 본다.
// psql 은 얇은 전송(같은 스크립트를 stdin 으로)이라 가짜로 본다. 실 DB 는 수동(G3 6단계).
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FKS, TABLES } from '../backup.ts';
import { backupCounts, copyText, ORDER, psqlScript, restore, restoreSteps, topoSort, type Step } from './restore.ts';

type Row = Record<string, unknown>;
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T1 = '2026-10-28T03:00:00.123456+00:00', T2 = '2026-10-28T03:00:00+00:00', T3 = '2026-01-02T23:59:59.5+00:00';
const TRICKY = 'tab\there\nnew line\r\nback\\slash \\. \\N \'single\' "double" 한글 🎉\n\\.';

// SQLite 에 들어 있는 모양 그대로(JSONB = JSON 문자열, boolean = 0/1). 없는 열은 null.
const DATA: Record<string, Row[]> = {
  users: [
    { id: u(1), nickname: '관리자', password_hash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA', role: 'admin', pw_updated_at: T1, created_at: T2, updated_at: T3 },
    { id: u(2), nickname: 'Teacher\t"1"', password_hash: '$argon2id$x', role: 'teacher', pw_updated_at: T2, created_at: T2, updated_at: T2 },
  ],
  groups: [{ id: u(10), name: TRICKY, created_at: T1, updated_at: T1 }],
  group_members: [{ group_id: u(10), user_id: u(2), created_at: T1 }],
  scenarios: [
    { id: u(20), slug: 'draft', status: 'draft', lang: 'ko', student_prefix: '🙂', mentor_prefix: '', grade: '3', internal: '{"a":[1,"둘",{"b":null}],"t":"x\\ty\\\\z"}', classification: '{"leverage":[],"object":[]}', compiled_prompt: null, created_at: T1, updated_at: T3 },
    { id: u(21), slug: 'pub', status: 'published', lang: 'en', student_prefix: '', mentor_prefix: '', grade: '', internal: '{}', classification: '{"leverage":["a"],"object":["b"]}', compiled_prompt: '{"student":"s\\n","analysis":null,"mentor":"m"}', created_at: T2, updated_at: T2 },
  ],
  scenario_translations: [{ id: u(30), scenario_id: u(21), lang: 'en', name: TRICKY, description: '', problem: 'p', chars: '', greet: 'hi', aha: '', t1: '', t2: '', t3: '', confused: '["?"]', elicit: '[]', misconceptions: '[{"id":1,"text":"x"}]', created_at: T1, updated_at: T1 }],
  group_scenarios: [{ group_id: u(10), scenario_id: u(21), created_at: T3 }],
  sessions: [
    { id: u(40), user_id: u(2), scenario_id: u(21), lang: 'en', started_at: T1, ended_at: T3, goal_reached: 1, counts: '{"a":2}', progress: '{"mis":[0,2]}', report: '{"summary":"한글\\n"}', turn_started_at: null, created_at: T1, updated_at: T3, turn_claim: null },
    { id: u(41), user_id: u(2), scenario_id: u(21), lang: 'en', started_at: T2, ended_at: null, goal_reached: 0, counts: '{}', progress: '{"mis":[]}', report: null, turn_started_at: T2, created_at: T2, updated_at: T2, turn_claim: u(99) },
  ],
  turns: [
    { id: u(50), session_id: u(40), seq: 0, speaker: 'teacher', text: TRICKY, leverage: 'a', object: null, trigger: null, created_at: T1, updated_at: T1 },
    { id: u(51), session_id: u(40), seq: 1, speaker: 'mentor', text: '', leverage: null, object: 'b', trigger: 2, created_at: T2, updated_at: T3 },
  ],
  ai_settings: [
    { role: 'student', key_source: 'own', provider: 'openai', key_masked: 'sk-…abcd', model: 'm', effort: null, key_added_at: T1, created_at: T1, updated_at: T1 },
    { role: 'mentor', key_source: 'student', provider: null, key_masked: null, model: null, effort: null, key_added_at: null, created_at: T1, updated_at: T1 },
  ],
  audit_log: [
    { id: u(60), actor_id: u(1), action: 'user.create', target: TRICKY, meta: '{"n":1.5,"s":"\\"q\\""}', created_at: T1 },
    { id: u(61), actor_id: null, action: 'admin.reset', target: null, meta: '{}', created_at: T3 },
  ],
};
const TEN = ['users', 'groups', 'group_members', 'scenarios', 'scenario_translations', 'group_scenarios', 'sessions', 'turns', 'ai_settings', 'audit_log'];

/** backup.ts 와 같은 모양의 SQLite 파일. */
function sqliteFile(data: Record<string, Row[]>, skip: { table?: string; col?: string } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'restore-test-')), 'remath-20261028.sqlite');
  const sq = new Database(file);
  for (const [t, cols] of Object.entries(TABLES)) {
    if (t === skip.table && !skip.col) continue;
    const keep = cols.filter(c => !(t === skip.table && c.name === skip.col));
    sq.exec(`create table "${t}" (${keep.map(c => `"${c.name}" ${c.type === 'int' || c.type === 'bool' ? 'INTEGER' : 'TEXT'}`).join(', ')})`);
    const ins = sq.prepare(`insert into "${t}" values (${keep.map(() => '?').join(', ')})`);
    for (const r of data[t] ?? []) ins.run(keep.map(c => r[c.name] ?? null));
  }
  sq.close();
  return file;
}

/** to_jsonb 로 읽은 행과 비교할 기대값: JSON 열은 값으로, boolean 은 true/false. */
const expected = (t: string) => (DATA[t] ?? []).map(r => Object.fromEntries(TABLES[t].map(c => {
  const v = r[c.name] ?? null;
  return [c.name, v === null ? null : c.type === 'json' ? JSON.parse(v as string) : c.type === 'bool' ? v === 1 : v];
})));
const sortRows = (rows: Row[]) => [...rows].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

describe('restore order (T-1 e)', () => {
  it('is the H-31 order and a topological order of the FK graph', () => {
    expect(ORDER).toEqual(TEN);
    expect(topoSort(ORDER, FKS)).toEqual(ORDER);   // FKS = 0001 의 FK 그래프(backup.test.ts 가 PGlite 로 맞춰 본다)
  });
  it('topoSort fixes a wrong order and rejects a cycle', () => {
    const wrong = ['turns', ...TEN.filter(t => t !== 'turns')];
    expect(topoSort(wrong, FKS)).not.toEqual(wrong);
    expect(topoSort(wrong, FKS).indexOf('turns')).toBeGreaterThan(topoSort(wrong, FKS).indexOf('sessions'));
    expect(() => topoSort(['a', 'b'], [{ table: 'a', ref: 'b' }, { table: 'b', ref: 'a' }])).toThrow(/cycle/);
  });
});

describe('COPY text', () => {
  it('escapes backslash, tab, newline and CR; null is \\N; booleans are t/f', () => {
    expect(copyText('turns', [DATA.turns[0]])).toBe(
      `${u(50)}\t${u(40)}\t0\tteacher\ttab\\there\\nnew line\\r\\nback\\\\slash \\\\. \\\\N 'single' "double" 한글 🎉\\n\\\\.\ta\t\\N\t\\N\t${T1}\t${T1}\n`);
    expect(copyText('sessions', [DATA.sessions[1]]).split('\t')[6]).toBe('f');
    expect(copyText('sessions', [DATA.sessions[0]]).split('\t')[6]).toBe('t');
  });
});

describe('backup file checks (before any project is created)', () => {
  it('counts rows per table', () => {
    expect(backupCounts(sqliteFile(DATA))).toEqual(Object.fromEntries(TEN.map(t => [t, DATA[t]?.length ?? 0])));
  });
  it('rejects a missing file, a non-SQLite file, a missing table or column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'restore-test-'));
    writeFileSync(join(dir, 'junk.sqlite'), 'not a database at all, just text');
    expect(() => backupCounts(join(dir, 'nope.sqlite'))).toThrow();
    expect(() => backupCounts(join(dir, 'junk.sqlite'))).toThrow(/not a readable SQLite backup/);
    expect(() => backupCounts(sqliteFile(DATA, { table: 'turns' }))).toThrow(/table turns is missing/);
    expect(() => backupCounts(sqliteFile(DATA, { table: 'sessions', col: 'turn_claim' }))).toThrow(/sessions\.turn_claim is missing/);
  });
});

describe('restore into a migrated database (PGlite, 0001~)', () => {
  const pg = new PGlite();
  const all = async (t: string) => (await pg.query<{ r: Row }>(`select to_jsonb(x) - 'key_ciphertext' r from "${t}" x`)).rows.map(x => x.r);
  /** psql 대신: 같은 단계를 한 트랜잭션에서, COPY 는 PGlite 의 /dev/blob 으로. */
  const apply = (steps: Step[]) => pg.transaction(async tx => {
    for (const s of steps) {
      if ('sql' in s) await tx.exec(s.sql);
      else await tx.query(`copy "${s.table}" (${s.cols.map(c => `"${c}"`).join(', ')}) from '/dev/blob'`, [], { blob: new Blob([s.data]) });
    }
  });
  beforeAll(async () => {
    await pg.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;');
    const dir = new URL('../../../db/migrations/', import.meta.url);
    for (const f of readdirSync(dir).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()) await pg.exec(readFileSync(new URL(f, dir), 'utf8'));
    await pg.exec(`set timezone to 'UTC'`);   // to_jsonb 의 timestamptz = PostgREST 가 백업에 준 모양(Supabase 는 UTC)
  }, 60_000);
  beforeEach(() => pg.exec(`truncate ${TEN.join(', ')}, auth_sessions`));
  afterAll(() => pg.close());

  it('every row round-trips exactly (JSON values, timestamps, uuids, nulls, booleans, tricky text); no auth_sessions; key_ciphertext null', async () => {
    await apply(restoreSteps(sqliteFile(DATA)));
    for (const t of TEN) expect(sortRows(await all(t)), t).toEqual(sortRows(expected(t)));
    expect((await pg.query('select count(*)::int n from auth_sessions')).rows).toEqual([{ n: 0 }]);
    expect((await pg.query('select count(*)::int n from ai_settings where key_ciphertext is not null')).rows).toEqual([{ n: 0 }]);
    expect((await pg.query(`select version from schema_migrations order by 1`)).rows.length).toBeGreaterThan(0);   // 마이그레이션 기록은 그대로
  });

  it('a failure in the last table leaves every table empty (one transaction)', async () => {
    await expect(apply(restoreSteps(sqliteFile({ ...DATA, audit_log: [{ ...DATA.audit_log[0], meta: 'not json' }] })))).rejects.toThrow(/json/i);
    for (const t of TEN) expect(await all(t), t).toEqual([]);
  });

  it('refuses a target that already has rows, and changes nothing', async () => {
    await apply(restoreSteps(sqliteFile(DATA)));
    await expect(apply(restoreSteps(sqliteFile(DATA)))).rejects.toThrow(/restore target is not empty: users/);
    expect(await all('turns')).toHaveLength(2);
  });

  it('there are no sequences or identity columns to move forward', async () => {
    expect((await pg.query(`select count(*)::int n from information_schema.sequences where sequence_schema = 'public'`)).rows).toEqual([{ n: 0 }]);
    expect((await pg.query(`select count(*)::int n from information_schema.columns where table_schema = 'public' and is_identity = 'YES'`)).rows).toEqual([{ n: 0 }]);
  });
});

describe('psql transport', () => {
  it('sends one script on stdin: terse errors (no row values), stop on error, single transaction, \\copy per table in order', () => {
    const calls: { args: string[]; input: string }[] = [];
    const counts = restore('postgresql://u:p@h:5432/postgres', sqliteFile(DATA), (args, input) => { calls.push({ args, input }); });
    expect(counts.turns).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['postgresql://u:p@h:5432/postgres', '-X', '-q', '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse', '-f', '-']);
    const s = calls[0].input;
    expect(s).toBe(psqlScript(restoreSteps(sqliteFile(DATA))));
    expect(s.startsWith('\\encoding UTF8\n')).toBe(true);
    expect(s.match(/^\\copy "\w+" /gm)).toEqual(TEN.map(t => `\\copy "${t}" `));
    expect(s).toContain(`\\copy "turns" (${TABLES.turns.map(c => `"${c.name}"`).join(', ')}) from stdin\n${copyText('turns', DATA.turns)}\\.\n`);
    expect(s).not.toMatch(/auth_sessions"|schema_migrations"|key_ciphertext/);
  });
});
