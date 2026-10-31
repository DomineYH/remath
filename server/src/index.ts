// 로컬 단일 프로세스 기동(dev·e2e·npm start): 검증(fail-fast) → 앱 → listen. 실행은 `npm run start -w server`(raw-hooks 필요, package.json).
// Vercel 진입점은 vercel.ts 다. 기동 시 턴 해제는 하지 않는다(V6): 고아 턴은 claim_turn 의 시간 초과 재획득(0003)이 맡는다.
// 매일 백업은 프로세스 타이머가 아니라 크론 경로(GET /api/cron/backup, cron.ts, V9)다. 로컬 파일 백업은 `npm run backup` CLI.
import { readFileSync } from 'node:fs';
import { buildApp } from './app.ts';
import { loadConfig, type Config } from './config.ts';
import { vercelBlob } from './cron.ts';
import { createDb } from './db.ts';
import { providersFor } from './providers/index.ts';

const ROOT = new URL('../../', import.meta.url);
let config: Config;
try {
  config = loadConfig(process.env, path => readFileSync(new URL(path, ROOT), 'utf8'));
} catch (err) {
  console.error(`remath server refused to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
const db = createDb(config.env.SUPABASE_URL, config.env.SUPABASE_SERVICE_KEY);
const app = await buildApp({ db, config, providersFor, blob: vercelBlob() }, { logger: true });
app.log.info(`llm: ${config.env.MOCK_LLM === '0' ? 'live' : 'mock'}`);
await app.listen({ port: config.env.PORT, host: '0.0.0.0' });
