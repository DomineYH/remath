// Vercel Node 함수 진입점(V3). scripts/build-vercel.mjs 가 rolldown 으로 묶는다(`?raw` 로더 포함). 로컬 단일 프로세스 기동은 index.ts.
// 디스크 대신 번들에 넣은 텍스트로 loadConfig 를 부른다(V5): providers.json 은 `?raw`, 템플릿은 @remath/prompts 의 TEMPLATES.
// 앱은 인스턴스마다 첫 요청 때 한 번 만든다. 기동 시 턴 해제는 없다(V6). 매일 백업 = 크론 경로(cron.ts, V9).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TEMPLATES } from '@remath/prompts';
import type { FastifyInstance } from 'fastify';
import providersText from '../../shared/providers.json?raw';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { vercelBlob } from './cron.ts';
import { createDb } from './db.ts';
import { providersFor } from './providers/index.ts';

/** loadConfig 의 read: 저장소 루트 기준 경로 → 번들에 든 텍스트. 없는 경로는 throw(빌드에서 빠진 파일). */
export function bundledRead() {
  const files: Record<string, string> = { 'shared/providers.json': providersText };
  for (const [name, byLang] of Object.entries(TEMPLATES))
    for (const [lang, text] of Object.entries(byLang)) files[`prompts/templates/${name}.${lang}.md`] = text;
  return (path: string) => {
    const text = files[path];
    if (text === undefined) throw new Error(`not bundled: ${path}`);
    return text;
  };
}

async function init() {
  let config;
  try { config = loadConfig(process.env, bundledRead()); }
  catch (err) {
    // fail-fast(index.ts 와 같은 문구). 함수는 끝내지 않고 이 요청에 500, 다음 요청이 다시 검증한다.
    console.error(`remath server refused to start: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
  const db = createDb(config.env.SUPABASE_URL, config.env.SUPABASE_SERVICE_KEY);
  const app = await buildApp({ db, config, providersFor, blob: vercelBlob() }, { logger: true });
  await app.ready();
  app.log.info(`llm: ${config.env.MOCK_LLM === '0' ? 'live' : 'mock'}`);
  return app;
}

let ready: Promise<FastifyInstance> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  let app: FastifyInstance;
  try { app = await (ready ??= init().catch(err => { ready = undefined; throw err; })); }
  catch {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { code: 'internal', message: 'internal error' } }));   // app.ts 오류 처리기의 500 과 같은 모양
    return;
  }
  app.server.emit('request', req, res);
}
