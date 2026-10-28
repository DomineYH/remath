// SQLite 백업 (H-30, T-1 (e)): 테이블·열 집합, Data API 페이지 읽기, 임시 파일 → rename, 보관 개수, 매일 타이머, env 검증.
// Data API 는 가짜 PostgREST(fetch) 로, 열 집합은 PGlite 에 마이그레이션을 실제로 올려 맞춰 본다. 실 DB 는 수동(LIVE CHECK).
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { backup, BackupEnv, scheduleBackups, TABLES } from './backup.ts';
import type { Db } from './db.ts';

type Row = Record<string, unknown>;
const TEN = ['users', 'groups', 'group_members', 'scenarios', 'scenario_translations', 'group_scenarios', 'sessions', 'turns', 'ai_settings', 'audit_log'];
const D1 = new Date(2026, 9, 28, 3, 0);   // 서버 로컬 시각

/** select·order·offset·limit 만 아는 PostgREST. maxRows = 서버의 db-max-rows(요청 limit 보다 작을 수 있다). fail = 실패시킬 테이블. */
function fakeDb(data: Record<string, Row[]>, o: { maxRows?: number; fail?: string } = {}) {
  const requests: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input)), table = url.pathname.split('/').pop()!, q = url.searchParams;
    requests.push(`${table}?${q}`);
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
  sessions: [{ id: 's1', user_id: 'u1', scenario_id: 'c1', goal_reached: true, counts: {}, progress: { mis: [0, 2] }, report: null }],
  turns: turns(7),
  ai_settings: [{ role: 'student', key_source: 'own', key_ciphertext: 'SECRET', key_masked: 'sk-…abcd' }],
};
const tmp = () => mkdtempSync(join(tmpdir(), 'backup-test-'));
const open = (file: string) => new Database(file, { readonly: true });

describe('backup file (H-30, T-1 e)', () => {
  it('has exactly the 10 tables, same column names as the migrations, no key_ciphertext, no auth_sessions/schema_migrations', async () => {
    const pg = new PGlite();
    await pg.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;');
    const dir = new URL('../../db/migrations/', import.meta.url);
    for (const f of readdirSync(dir).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()) await pg.exec(readFileSync(new URL(f, dir), 'utf8'));
    const cols = (await pg.query<{ t: string; c: string }>(`select table_name t, column_name c from information_schema.columns
      where table_schema = 'public' and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')
      order by table_name, ordinal_position`)).rows;
    const live: Record<string, string[]> = {};
    for (const { t, c } of cols) (live[t] ??= []).push(c);

    expect(Object.keys(TABLES)).toEqual(TEN);
    expect(Object.keys(live).sort()).toEqual([...TEN, 'auth_sessions', 'schema_migrations'].sort());
    for (const t of TEN) expect(TABLES[t].map(c => c.name), t).toEqual(live[t].filter(c => !(t === 'ai_settings' && c === 'key_ciphertext')));
    expect(live.ai_settings).toContain('key_ciphertext');
    await pg.close();
  }, 60_000);

  it('reads every page through the Data API and writes remath-<YYYYMMDD>.sqlite with JSONB as TEXT', async () => {
    const dir = tmp(), { db, requests } = fakeDb(DATA, { maxRows: 2 });   // 서버 max-rows(2) < 페이지(3) 여도 빠짐없이 읽는다
    const r = await backup(db, { dir, keep: 3, now: D1, pageSize: 3 });

    expect(r.file).toBe(join(dir, 'remath-20261028.sqlite'));
    expect(readdirSync(dir)).toEqual(['remath-20261028.sqlite']);   // 임시 파일이 남지 않는다
    expect(r.rows).toMatchObject({ users: 1, turns: 7, ai_settings: 1, groups: 0 });
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
