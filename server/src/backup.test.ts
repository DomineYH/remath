// SQLite 백업 (H-30, T-1 (e)): 테이블·열 집합, Data API 페이지 읽기, 임시 파일 → rename, 보관 개수, 매일 타이머, env 검증.
// Data API 는 가짜 PostgREST(fetch) 로, 열 집합은 PGlite 에 마이그레이션을 실제로 올려 맞춰 본다. 실 DB 는 수동(LIVE CHECK).
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backup, BackupEnv, FKS, scheduleBackups, TABLES } from './backup.ts';
import type { Db } from './db.ts';

type Row = Record<string, unknown>;
const TEN = ['users', 'groups', 'group_members', 'scenarios', 'scenario_translations', 'group_scenarios', 'sessions', 'turns', 'ai_settings', 'audit_log'];
const D1 = new Date(2026, 9, 28, 3, 0);   // 서버 로컬 시각

/** select·order·offset·limit 만 아는 PostgREST. maxRows = 서버의 db-max-rows(요청 limit 보다 작을 수 있다). fail = 실패시킬 테이블.
 *  onRead = 요청에 답하기 직전(그 사이 커밋된 쓰기를 data 에 반영해 끼어들기를 재현한다). */
function fakeDb(data: Record<string, Row[]>, o: { maxRows?: number; fail?: string; onRead?: (table: string, q: URLSearchParams) => void } = {}) {
  const requests: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input)), table = url.pathname.split('/').pop()!, q = url.searchParams;
    requests.push(`${table}?${q}`);
    o.onRead?.(table, q);
    if (table === o.fail) return new Response(JSON.stringify({ message: 'injected failure' }), { status: 500 });
    const offset = Number(q.get('offset') ?? 0), limit = Math.min(Number(q.get('limit') ?? Infinity), o.maxRows ?? Infinity);
    const cols = q.get('select')!.split(',');
    const rows = (data[table] ?? []).slice(offset, offset + limit).map(r => Object.fromEntries(cols.map(c => [c, r[c] ?? null])));
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const db = createClient('https://p.supabase.co', 'service', { global: { fetch }, auth: { persistSession: false } }) as unknown as Db;
  return { db, requests };
}

const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${String(i).padStart(2, '0')}`, session_id: 's1', seq: i, speaker: 'teacher', text: `발화 ${i}`, trigger: null }));
const DATA: Record<string, Row[]> = {
  users: [{ id: 'u1', nickname: 'admin', password_hash: '$argon2id$x', role: 'admin' }],
  scenarios: [{ id: 'c1', slug: 's', internal: { a: [1, '둘'] }, classification: { leverage: [], object: [] }, compiled_prompt: null }],
  sessions: [{ id: 's1', user_id: 'u1', scenario_id: 'c1', goal_reached: true, counts: {}, progress: { mis: [0, 2] }, report: null, updated_at: '2026-10-28T02:00:00+00:00' }],
  turns: turns(7),
  ai_settings: [{ role: 'student', key_source: 'own', key_ciphertext: 'SECRET', key_masked: 'sk-…abcd' }],
};
const tmp = () => mkdtempSync(join(tmpdir(), 'backup-test-'));
const open = (file: string) => new Database(file, { readonly: true });

describe('backup file (H-30, T-1 e)', () => {
  // 마이그레이션 전부를 PGlite 에 올린 스키마가 기준이다: 새 열·새 FK 가 생기면 아래 두 테스트가 깨진다.
  const pg = new PGlite();
  beforeAll(async () => {
    await pg.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;');
    const dir = new URL('../../db/migrations/', import.meta.url);
    for (const f of readdirSync(dir).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()) await pg.exec(readFileSync(new URL(f, dir), 'utf8'));
  }, 60_000);
  afterAll(() => pg.close());

  it('has exactly the 10 tables, same column names as the migrations, no key_ciphertext, no auth_sessions/schema_migrations', async () => {
    const cols = (await pg.query<{ t: string; c: string }>(`select table_name t, column_name c from information_schema.columns
      where table_schema = 'public' and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')
      order by table_name, ordinal_position`)).rows;
    const live: Record<string, string[]> = {};
    for (const { t, c } of cols) (live[t] ??= []).push(c);

    expect(Object.keys(TABLES)).toEqual(TEN);
    expect(Object.keys(live).sort()).toEqual([...TEN, 'auth_sessions', 'schema_migrations'].sort());
    for (const t of TEN) expect(TABLES[t].map(c => c.name), t).toEqual(live[t].filter(c => !(t === 'ai_settings' && c === 'key_ciphertext')));
    expect(live.ai_settings).toContain('key_ciphertext');
  });

  it('knows every foreign key between the backed-up tables, with its on-delete rule', async () => {
    const fks = (await pg.query<{ t: string; n: number; col: string; ref: string; refcol: string; d: string }>(`
      select c.conrelid::regclass::text t, array_length(c.conkey, 1) n, a.attname col, c.confrelid::regclass::text ref, af.attname refcol, c.confdeltype d
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        join pg_attribute af on af.attrelid = c.confrelid and af.attnum = c.confkey[1]
       where c.contype = 'f'`)).rows.filter(f => TEN.includes(f.t));
    expect(fks.every(f => f.n === 1 && TEN.includes(f.ref))).toBe(true);
    const key = (f: { table: string; col: string; ref: string; refCol: string; setNull: boolean }) => `${f.table}.${f.col} -> ${f.ref}.${f.refCol}${f.setNull ? ' set null' : ''}`;
    expect(FKS.map(key).sort()).toEqual(fks.map(f => key({ table: f.t, col: f.col, ref: f.ref, refCol: f.refcol, setNull: f.d === 'n' })).sort());
    // 부모가 자식보다 먼저 정리돼야 연쇄 고아(사라진 세션의 발화)까지 지워진다.
    for (const f of FKS) expect(TEN.indexOf(f.ref), key(f)).toBeLessThan(TEN.indexOf(f.table));
  });

  it('reads every page through the Data API and writes remath-<YYYYMMDD>.sqlite with JSONB as TEXT', async () => {
    const dir = tmp(), { db, requests } = fakeDb(DATA, { maxRows: 2 });   // 서버 max-rows(2) < 페이지(3) 여도 빠짐없이 읽는다
    const r = await backup(db, { dir, keep: 3, now: D1, pageSize: 3 });

    expect(r.file).toBe(join(dir, 'remath-20261028.sqlite'));
    expect(readdirSync(dir)).toEqual(['remath-20261028.sqlite']);   // 임시 파일이 남지 않는다
    expect(r.rows).toMatchObject({ users: 1, turns: 7, ai_settings: 1, groups: 0 });
    expect(r.pruned).toEqual({});   // 깨끗한 읽기는 아무것도 정리하지 않는다
    expect(requests.every(q => !q.includes('key_ciphertext'))).toBe(true);
    expect(requests.filter(q => q.startsWith('turns?'))).toEqual(
      [0, 2, 4, 6, 7].map(o => `turns?select=${TABLES.turns.map(c => c.name).join('%2C')}&order=id.asc&offset=${o}&limit=3`));

    const s = open(r.file);
    expect(s.prepare(`select name from sqlite_master where type = 'table' order by name`).pluck().all()).toEqual([...TEN].sort());
    expect(s.prepare(`select name from pragma_table_info('ai_settings')`).pluck().all()).not.toContain('key_ciphertext');
    expect(s.prepare('select count(*) from turns').pluck().get()).toBe(7);
    expect(s.prepare('select text from turns order by seq desc limit 1').pluck().get()).toBe('발화 6');
    const sc = s.prepare('select internal, classification, compiled_prompt, typeof(internal) ty from scenarios').get() as Row;
    expect(sc).toEqual({ internal: '{"a":[1,"둘"]}', classification: '{"leverage":[],"object":[]}', compiled_prompt: null, ty: 'text' });
    expect(JSON.parse(sc.internal as string)).toEqual(DATA.scenarios[0].internal);
    expect(s.prepare('select goal_reached, progress from sessions').get()).toEqual({ goal_reached: 1, progress: '{"mis":[0,2]}' });
    s.close();
  });

  it('drops rows whose parent was not read (written mid-run) so the file restores in FK order; actor_id is nulled', async () => {
    const dir = tmp();
    // 부모 테이블을 읽은 뒤 커밋된 자식들: 새 사용자 u2 의 세션·발화·그룹 소속, 새 그룹 g9 의 시나리오 연결, 새 시나리오의 번역, 새 사용자의 감사 행.
    const late = {
      ...DATA,
      sessions: [...DATA.sessions, { id: 's2', user_id: 'u2', scenario_id: 'c1', goal_reached: false, counts: {}, progress: { mis: [] } }],
      turns: [...turns(2), { id: 't9', session_id: 's2', seq: 0, speaker: 'student', text: 'hi' }, { id: 't8', session_id: 's7', seq: 0, speaker: 'student', text: 'hi' }],
      groups: [{ id: 'g1', name: 'A' }],
      group_members: [{ group_id: 'g1', user_id: 'u1' }, { group_id: 'g1', user_id: 'u2' }],
      group_scenarios: [{ group_id: 'g9', scenario_id: 'c1' }],
      scenario_translations: [{ id: 'tr1', scenario_id: 'c1', lang: 'ko' }, { id: 'tr2', scenario_id: 'c2', lang: 'ko' }],
      audit_log: [{ id: 'a1', actor_id: 'u1', action: 'x', meta: {} }, { id: 'a2', actor_id: 'u2', action: 'y', meta: {} }, { id: 'a3', actor_id: null, action: 'z', meta: {} }],
    };
    const r = await backup(fakeDb(late).db, { dir, keep: 3, now: D1 });
    expect(r.pruned).toEqual({ sessions: 1, turns: 2, group_members: 1, group_scenarios: 1, scenario_translations: 1, audit_log: 1 });
    const s = open(r.file), ids = (sql: string) => s.prepare(sql).pluck().all();
    expect(ids('select id from sessions')).toEqual(['s1']);
    expect(ids('select id from turns order by id')).toEqual(['t00', 't01']);
    expect(ids('select user_id from group_members')).toEqual(['u1']);
    expect(ids('select count(*) from group_scenarios')).toEqual([0]);
    expect(ids('select id from scenario_translations')).toEqual(['tr1']);
    expect(s.prepare('select id, actor_id from audit_log order by id').all()).toEqual([{ id: 'a1', actor_id: 'u1' }, { id: 'a2', actor_id: null }, { id: 'a3', actor_id: null }]);
    s.close();
  });

  // record_turn 이 sessions 를 읽은 뒤·turns 를 읽기 전에 커밋한다: 새 발화 + 세션 상태(counts·progress·updated_at)가 함께 바뀐다.
  const recordTurn = (d: Record<string, Row[]>, n: number) => {
    d.turns = [...d.turns, { id: `t9${n}`, session_id: 's1', seq: 100 + n, speaker: 'teacher', text: `늦은 발화 ${n}`, trigger: null }];
    d.sessions = d.sessions.map(s => s.id === 's1' ? { ...s, counts: { Eliciting: n }, progress: { mis: [n, 2] }, updated_at: `2026-10-28T03:00:0${n}+00:00` } : s);
  };
  it('a turn committed between the sessions and turns reads: the read is redone, the file holds one committed state per session', async () => {
    const dir = tmp(), d = structuredClone(DATA);
    let commits = 0;
    const { db, requests } = fakeDb(d, { onRead: (table, q) => { if (table === 'turns' && !commits && q.get('offset') === '0') recordTurn(d, ++commits); } });
    const r = await backup(db, { dir, keep: 3, now: D1 });
    expect(requests.filter(q => q.startsWith('sessions?') && q.includes('counts') && q.includes('offset=0')).length).toBe(2);   // 첫 판은 버리고 다시 읽었다
    const s = open(r.file);
    expect(s.prepare('select counts, progress, updated_at from sessions').get()).toEqual({ counts: '{"Eliciting":1}', progress: '{"mis":[1,2]}', updated_at: '2026-10-28T03:00:01+00:00' });
    expect(s.prepare(`select text from turns where id = 't91'`).pluck().get()).toBe('늦은 발화 1');
    expect(r.rows.turns).toBe(8);
    s.close();
  });

  it('sessions that keep changing exhaust the retries: error, no file, the previous backup is kept', async () => {
    const dir = tmp();
    await backup(fakeDb(DATA).db, { dir, keep: 3, now: D1 });
    const before = readFileSync(join(dir, 'remath-20261028.sqlite'));
    const d = structuredClone(DATA);
    let commits = 0;
    const { db, requests } = fakeDb(d, { onRead: (table, q) => { if (table === 'turns' && q.get('offset') === '0') recordTurn(d, ++commits); } });
    await expect(backup(db, { dir, keep: 3, now: D1 })).rejects.toThrow(/sessions changed during the read/);
    expect(commits).toBe(5);
    expect(requests.filter(q => q.startsWith('sessions?') && q.includes('counts') && q.includes('offset=0')).length).toBe(5);
    expect(readdirSync(dir)).toEqual(['remath-20261028.sqlite']);
    expect(readFileSync(join(dir, 'remath-20261028.sqlite'))).toEqual(before);
  });

  it('a session started or deleted mid-read is caught too (the re-read id set differs)', async () => {
    const dir = tmp(), d = structuredClone(DATA);
    let done = false;
    const { db, requests } = fakeDb(d, { onRead: table => { if (table === 'turns' && !done) { done = true; d.sessions = []; d.turns = []; } } });
    const r = await backup(db, { dir, keep: 3, now: D1 });
    expect(requests.filter(q => q.startsWith('sessions?') && q.includes('counts') && q.includes('offset=0')).length).toBe(2);
    expect(r.rows).toMatchObject({ sessions: 0, turns: 0 });
  });

  it('the file is 0600 (it holds password hashes), also when it replaces an older file of the same date', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'remath-20261028.sqlite'), 'old', { mode: 0o644 });
    const r = await backup(fakeDb(DATA).db, { dir, keep: 3, now: D1 });
    expect(statSync(r.file).mode & 0o777).toBe(0o600);
  });

  it('leaves no file behind when a read fails, and keeps the previous backup', async () => {
    const dir = tmp();
    await backup(fakeDb(DATA).db, { dir, keep: 3, now: D1 });
    const before = readFileSync(join(dir, 'remath-20261028.sqlite'));
    await expect(backup(fakeDb(DATA, { fail: 'turns' }).db, { dir, keep: 3, now: D1 })).rejects.toMatchObject({ message: 'injected failure' });
    expect(readdirSync(dir)).toEqual(['remath-20261028.sqlite']);
    expect(readFileSync(join(dir, 'remath-20261028.sqlite'))).toEqual(before);
  });

  it('overwrites the same date and keeps only the newest BACKUP_KEEP files', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'notes.txt'), 'not a backup');
    const day = (d: number) => new Date(2026, 9, d, 3, 0);
    for (const d of [26, 27, 28]) await backup(fakeDb(DATA).db, { dir, keep: 2, now: day(d) });
    await backup(fakeDb({ ...DATA, turns: turns(1) }).db, { dir, keep: 2, now: day(28) });
    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'remath-20261027.sqlite', 'remath-20261028.sqlite']);
    const s = open(join(dir, 'remath-20261028.sqlite'));
    expect(s.prepare('select count(*) from turns').pluck().get()).toBe(1);
    s.close();
  });
});

describe('daily timer (H-30, user story 23)', () => {
  function clock(start: Date) {
    let t = start.getTime(), pending: (() => void) | null = null;
    const delays: number[] = [];
    return {
      delays, now: () => new Date(t),
      setTimer: (fn: () => void, ms: number) => { delays.push(ms); pending = fn; },
      /** 잡힌 시각으로 시계를 옮기고 타이머를 부른다. */
      fire: () => { t += delays.at(-1)!; const fn = pending!; pending = null; fn(); },
    };
  }
  const settle = () => new Promise(r => setTimeout(r, 0));

  it('runs at BACKUP_AT server-local time every day, one run at a time; a failure is logged and the next day still runs', async () => {
    const c = clock(new Date(2026, 9, 28, 2, 59)), logged: unknown[] = [];
    let runs = 0, finish!: () => void;
    const run = () => { runs++; return runs === 1 ? Promise.reject(new Error('boom')) : new Promise<void>(r => { finish = r; }); };
    scheduleBackups({ at: '03:00', run, log: e => logged.push(e), now: c.now, setTimer: c.setTimer });
    expect(c.delays).toEqual([60_000]);

    c.fire(); await settle();
    expect(runs).toBe(1);
    expect(logged).toEqual([new Error('boom')]);
    expect(c.delays.at(-1)).toBe(24 * 3600_000);

    c.fire(); await settle();
    expect(runs).toBe(2);
    expect(c.delays).toHaveLength(2);   // 끝나기 전에는 다음 실행을 잡지 않는다
    finish(); await settle();
    expect(c.delays).toHaveLength(3);
  });

  it('waits for tomorrow when BACKUP_AT has passed today', () => {
    const c = clock(new Date(2026, 9, 28, 3, 1));
    scheduleBackups({ at: '03:00', run: async () => {}, log: () => {}, now: c.now, setTimer: c.setTimer });
    expect(c.delays).toEqual([(24 * 60 - 1) * 60_000]);
  });
});

describe('BackupEnv (#40: validated where it is read)', () => {
  it('defaults and parses', () => {
    expect(BackupEnv.parse({})).toEqual({ BACKUP_DIR: 'backup', BACKUP_KEEP: 7, BACKUP_AT: '03:00' });
    expect(BackupEnv.parse({ BACKUP_DIR: '/b', BACKUP_KEEP: '2', BACKUP_AT: '23:59' })).toEqual({ BACKUP_DIR: '/b', BACKUP_KEEP: 2, BACKUP_AT: '23:59' });
  });
  it.each([{ BACKUP_KEEP: '0' }, { BACKUP_KEEP: 'x' }, { BACKUP_AT: '24:00' }, { BACKUP_AT: '3:00' }, { BACKUP_DIR: '' }])('rejects %o', env => {
    expect(BackupEnv.safeParse(env).success).toBe(false);
  });
});
