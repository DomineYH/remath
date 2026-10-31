// 매일 백업 크론(V9, H-30): Vercel Cron → GET /api/cron/backup(라우트 표 밖의 운영 경로, CRON_SECRET Bearer).
// /tmp 에 backup() → Blob 비공개 저장소에 올림 → 그 환경 접두어 안에서 새것부터 BACKUP_KEEP 개만 남긴다.
// production 은 저장소 뿌리, 그 밖(preview·development·로컬)은 `<VERCEL_ENV|local>/` 아래: 수동 Preview 호출이 실서버 백업을 지우지 않게.
// 실패하면 로그 1줄(오류 문구만)과 500, 서비스는 그대로다.
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { del, list, put } from '@vercel/blob';
import type { FastifyInstance } from 'fastify';
import type { Deps } from './app.ts';
import { backup } from './backup.ts';
import { ApiFail } from './errors.ts';

export const CRON_BACKUP = '/api/cron/backup';

/** 크론이 쓰는 Blob 의 좁은 면. 실물은 vercelBlob(), 테스트는 가짜. */
export interface BlobStore {
  put(pathname: string, body: Buffer): Promise<void>;
  list(prefix: string, cursor?: string): Promise<{ blobs: { pathname: string; url: string }[]; cursor?: string; hasMore: boolean }>;
  del(urls: string[]): Promise<void>;
}

/** @vercel/blob 을 감싼다. 토큰은 SDK 가 BLOB_READ_WRITE_TOKEN 에서 직접 읽는다. 같은 날 다시 돌면 덮어쓴다. */
export function vercelBlob(): BlobStore {
  return {
    async put(pathname, body) { await put(pathname, body, { access: 'private', addRandomSuffix: false, allowOverwrite: true }); },
    async list(prefix, cursor) {
      const r = await list({ prefix, cursor });
      return { blobs: r.blobs.map(b => ({ pathname: b.pathname, url: b.url })), cursor: r.cursor, hasMore: r.hasMore };
    },
    async del(urls) { await del(urls); },
  };
}

const digest = (s: string) => createHash('sha256').update(s).digest();
/** Authorization === `Bearer <secret>` 를 상수 시간으로 비교한다(같은 길이의 해시끼리). 비밀이 없거나 비면 늘 false. */
export function authorized(header: string | undefined, secret: string | undefined) {
  if (!secret || header === undefined) return false;
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

/** 오류 문구만(PostgREST 오류는 Error 가 아닌 객체다). details·hint 는 행 값을 담을 수 있어 넣지 않는다. */
const message = (err: unknown) => {
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : String(err);
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function run(d: Deps, blob: BlobStore | undefined) {
  if (!blob) throw new Error('blob store not wired');
  const { VERCEL_ENV, BACKUP_KEEP } = d.config.env;
  const prefix = VERCEL_ENV === 'production' ? '' : `${VERCEL_ENV ?? 'local'}/`;
  const dir = await mkdtemp(join(tmpdir(), 'remath-backup-'));
  try {
    const r = await backup(d.db, { dir, keep: 1, now: d.now() });
    const pathname = prefix + basename(r.file);
    await blob.put(pathname, await readFile(r.file));
    const ours = new RegExp(`^${escape(prefix)}remath-\\d{8}\\.sqlite$`), found: { pathname: string; url: string }[] = [];
    for (let cursor: string | undefined; ;) {
      const page = await blob.list(`${prefix}remath-`, cursor);
      found.push(...page.blobs.filter(b => ours.test(b.pathname)));
      if (!page.hasMore || !page.cursor) break;
      cursor = page.cursor;
    }
    const old = found.sort((a, b) => a.pathname < b.pathname ? -1 : 1).slice(0, -BACKUP_KEEP);
    if (old.length) await blob.del(old.map(b => b.url));
    return { ok: true, pathname, rows: r.rows, pruned: r.pruned, deleted: old.map(b => b.pathname) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** buildApp 이 등록한다(vercel.ts·index.ts 공통). blob 이 없으면 실행은 실패 경로로 간다. */
export function registerCron(app: FastifyInstance, d: Deps) {
  app.get(CRON_BACKUP, async (req, reply) => {
    if (!authorized(req.headers.authorization, d.config.env.CRON_SECRET)) throw new ApiFail('unauthorized', 'cron secret required');
    try {
      const r = await run(d, d.blob);
      if (Object.keys(r.pruned).length) req.log.warn({ pruned: r.pruned }, 'backup pruned orphan rows written during the run');
      req.log.info({ pathname: r.pathname, deleted: r.deleted }, 'backup ok');
      return r;
    } catch (err) {
      req.log.error(`backup failed: ${message(err)}`);
      return reply.code(500).send({ error: { code: 'internal', message: 'backup failed' } });   // app.ts 오류 처리기의 500 과 같은 모양
    }
  });
}
