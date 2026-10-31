// 백업 크론(V9, H-30): Bearer 인증, Blob 이름(환경 접두어), 보관 개수 정리, list 페이지, 실패 경로.
// Blob 은 가짜 저장소, DB 는 빈 테이블을 주는 가짜 PostgREST 로 실제 backup() 을 돌린다. 실 Blob·Vercel·DB 는 쓰지 않는다.
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { createClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import type { BlobStore } from './cron.ts';
import type { Db } from './db.ts';

const SECRET = 'cron-secret-0123456789';
const AUTH = { authorization: `Bearer ${SECRET}` };
const D1 = new Date(2026, 9, 31, 3, 0);   // 서버 로컬 시각 → remath-20261031
const disk = (p: string) => readFileSync(new URL(p, new URL('../../', import.meta.url)), 'utf8');
const cfg = (env: Record<string, string | undefined> = {}) =>
  loadConfig({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_KEY: 'service-key', MOCK_LLM: '1', CRON_SECRET: SECRET, ...env }, disk);

/** 모든 테이블이 비어 있는 PostgREST. fail 이면 500. */
function fakeDb(o: { fail?: boolean } = {}) {
  const fetch = (async () => o.fail
    ? new Response(JSON.stringify({ message: 'injected db failure' }), { status: 500 })
    : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
  return createClient('https://p.supabase.co', 'service-key', { global: { fetch }, auth: { persistSession: false } }) as unknown as Db;
}

/** pathname → 내용. pageSize 개씩 list 한다(cursor). fail = 실패시킬 메서드. */
function fakeBlob(names: string[] = [], o: { pageSize?: number; fail?: 'put' | 'list' | 'del' } = {}) {
  const store = new Map<string, Buffer>(names.map(n => [n, Buffer.from('old')]));
  const calls: string[] = [];
  const url = (p: string) => `https://store.private.blob.vercel-storage.com/${p}`;
  const boom = (m: string) => { if (o.fail === m) throw new Error(`injected ${m} failure`); };
  const blob: BlobStore = {
    async put(pathname, body) { calls.push(`put ${pathname}`); boom('put'); store.set(pathname, body); },
    async list(prefix, cursor) {
      calls.push(`list ${prefix} ${cursor ?? ''}`); boom('list');
      const all = [...store.keys()].filter(p => p.startsWith(prefix)).sort(), start = Number(cursor ?? 0), size = o.pageSize ?? 1000;
      const page = all.slice(start, start + size), more = start + size < all.length;
      return { blobs: page.map(p => ({ pathname: p, url: url(p) })), cursor: more ? String(start + size) : undefined, hasMore: more };
    },
    async del(urls) {
      calls.push(`del ${urls.length}`); boom('del');
      for (const u of urls) store.delete(u.slice(url('').length));
    },
  };
  return { blob, store, calls };
}

async function setup(o: { env?: Record<string, string | undefined>; blob?: BlobStore; db?: Db; now?: Date } = {}) {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({ write(chunk, _e, cb) { for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l)); cb(); } });
  const app = await buildApp({ db: o.db ?? fakeDb(), config: cfg(o.env), blob: o.blob ?? fakeBlob().blob, now: () => o.now ?? D1 },
    { logger: { level: 'info', stream } });
  return { app, lines, raw: () => JSON.stringify(lines) };
}
const backupDirs = () => readdirSync(tmpdir()).filter(f => f.startsWith('remath-backup-'));
const days = (prefix: string, ...d: number[]) => d.map(n => `${prefix}remath-202610${String(n).padStart(2, '0')}.sqlite`);

describe('GET /api/cron/backup auth (V9: CRON_SECRET Bearer)', () => {
  it.each([
    ['no Authorization header', {}, {}],
    ['a wrong secret', { authorization: 'Bearer wrong' }, {}],
    ['the secret without Bearer', { authorization: SECRET }, {}],
    ['CRON_SECRET unset', AUTH, { CRON_SECRET: undefined }],
    ['CRON_SECRET empty, empty Bearer', { authorization: 'Bearer ' }, { CRON_SECRET: '' }],
  ])('%s is 401 unauthorized and touches nothing', async (_n, headers, env) => {
    const b = fakeBlob(), { app } = await setup({ env, blob: b.blob, db: new Proxy({}, { get: () => { throw new Error('db used'); } }) as Db });
    const r = await app.inject({ url: '/api/cron/backup', headers });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toMatchObject({ code: 'unauthorized', message: expect.any(String) });
    expect(b.calls).toEqual([]);
  });
});

describe('GET /api/cron/backup run (V9, H-30)', () => {
  let before: string[];
  beforeEach(() => { before = backupDirs(); });

  it('production uploads remath-YYYYMMDD.sqlite at the store root, a SQLite file, and removes the tmp dir', async () => {
    const b = fakeBlob(), { app, raw } = await setup({ env: { VERCEL_ENV: 'production' }, blob: b.blob });
    const r = await app.inject({ url: '/api/cron/backup', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, pathname: 'remath-20261031.sqlite', rows: expect.objectContaining({ users: 0, turns: 0 }), pruned: {}, deleted: [] });
    expect(b.store.get('remath-20261031.sqlite')!.subarray(0, 15).toString()).toBe('SQLite format 3');
    expect(backupDirs()).toEqual(before);
    expect(raw()).not.toContain(SECRET);
  });

  it.each([['preview', 'preview/'], [undefined, 'local/']])('VERCEL_ENV=%s uploads under %s', async (VERCEL_ENV, prefix) => {
    const b = fakeBlob(), { app } = await setup({ env: { VERCEL_ENV }, blob: b.blob });
    const r = await app.inject({ url: '/api/cron/backup', headers: AUTH });
    expect(r.json().pathname).toBe(`${prefix}remath-20261031.sqlite`);
    expect([...b.store.keys()]).toEqual([`${prefix}remath-20261031.sqlite`]);
  });

  it('keeps the BACKUP_KEEP newest in its prefix; other prefixes and other names are left alone', async () => {
    const others = [...days('preview/', 1, 2, 3), 'remath-notes.txt', 'remath-2026103.sqlite', 'other/remath-20261001.sqlite'];
    const b = fakeBlob([...days('', 25, 27, 28, 29, 30), ...others]);
    const { app } = await setup({ env: { VERCEL_ENV: 'production', BACKUP_KEEP: '3' }, blob: b.blob });
    const r = await app.inject({ url: '/api/cron/backup', headers: AUTH });
    expect(r.json().deleted).toEqual(days('', 25, 27, 28));
    expect([...b.store.keys()].sort()).toEqual([...days('', 29, 30, 31), ...others].sort());
  });

  it('follows the list cursor across pages', async () => {
    const b = fakeBlob(days('preview/', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10), { pageSize: 3 });
    const { app } = await setup({ env: { VERCEL_ENV: 'preview' }, blob: b.blob });   // BACKUP_KEEP 기본 7
    const r = await app.inject({ url: '/api/cron/backup', headers: AUTH });
    expect(r.json().deleted).toEqual(days('preview/', 1, 2, 3, 4));
    expect(b.calls.filter(c => c.startsWith('list'))).toEqual(['list preview/remath- ', 'list preview/remath- 3', 'list preview/remath- 6', 'list preview/remath- 9']);
    expect([...b.store.keys()].sort()).toEqual(days('preview/', 5, 6, 7, 8, 9, 10, 31));
  });

  it('a same-day re-run overwrites that day and deletes nothing', async () => {
    const b = fakeBlob(days('', 31)), { app } = await setup({ env: { VERCEL_ENV: 'production' }, blob: b.blob });
    const r = await app.inject({ url: '/api/cron/backup', headers: AUTH });
    expect(r.json()).toMatchObject({ pathname: 'remath-20261031.sqlite', deleted: [] });
    expect(b.store.get('remath-20261031.sqlite')!.toString()).not.toBe('old');
    expect(b.store.size).toBe(1);
  });

  it.each([
    ['backup', { db: true }],
    ['put', { fail: 'put' as const }],
    ['list', { fail: 'list' as const }],
    ['del', { fail: 'del' as const }],
  ])('a %s failure is 500 in the error shape, one "backup failed" log line without secrets, tmp dir removed', async (what, o) => {
    const b = fakeBlob(days('', 1, 2, 3, 4, 5, 6, 7, 8), 'fail' in o ? { fail: o.fail } : {});
    const { app, lines, raw } = await setup({ env: { VERCEL_ENV: 'production' }, blob: b.blob, db: fakeDb({ fail: 'db' in o }) });
    const r = await app.inject({ url: '/api/cron/backup', headers: AUTH });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: { code: 'internal', message: 'backup failed' } });
    const errors = lines.filter(l => (l.level as number) >= 50);
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toMatch(new RegExp(`^backup failed: .*injected ${what === 'backup' ? 'db' : what} failure`));
    expect(Object.keys(errors[0]).sort()).toEqual(['hostname', 'level', 'msg', 'pid', 'reqId', 'time']);
    expect(raw()).not.toContain(SECRET);
    expect(raw()).not.toContain('service-key');
    expect(backupDirs()).toEqual(before);
  });

  it('without a wired Blob store the run fails the same way and the server keeps answering', async () => {
    const app = await buildApp({ db: fakeDb(), config: cfg(), now: () => D1 });
    expect((await app.inject({ url: '/api/cron/backup', headers: AUTH })).statusCode).toBe(500);
    expect((await app.inject('/healthz')).statusCode).toBe(200);
    expect(backupDirs()).toEqual(before);
  });
});

describe('vercelBlob: the real client wrapper', () => {
  it('puts private, no random suffix, overwrite allowed; lists by prefix and cursor; deletes by url', async () => {
    vi.resetModules();
    const put = vi.fn(async () => ({})), list = vi.fn(async () => ({ blobs: [{ pathname: 'a', url: 'u', size: 1 }], cursor: 'c', hasMore: true })), del = vi.fn(async () => {});
    vi.doMock('@vercel/blob', () => ({ put, list, del }));
    const { vercelBlob } = await import('./cron.ts');
    const b = vercelBlob();
    await b.put('remath-20261031.sqlite', Buffer.from('x'));
    expect(put).toHaveBeenCalledWith('remath-20261031.sqlite', Buffer.from('x'), { access: 'private', addRandomSuffix: false, allowOverwrite: true });
    expect(await b.list('p/', 'c0')).toEqual({ blobs: [{ pathname: 'a', url: 'u' }], cursor: 'c', hasMore: true });
    expect(list).toHaveBeenCalledWith({ prefix: 'p/', cursor: 'c0' });
    await b.del(['u']);
    expect(del).toHaveBeenCalledWith(['u']);
    vi.doUnmock('@vercel/blob');
  });
});
