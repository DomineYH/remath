// 기동: 검증(fail-fast) → 앱 → listen. 실행은 `npm run start -w server`(raw-hooks 필요, package.json).
import { readFileSync } from 'node:fs';
import { buildApp } from './app.ts';
import { loadConfig, type Config } from './config.ts';
import { createDb } from './db.ts';

const ROOT = new URL('../../', import.meta.url);
let config: Config;
try {
  config = loadConfig(process.env, path => readFileSync(new URL(path, ROOT), 'utf8'));
} catch (err) {
  console.error(`remath server refused to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
const app = await buildApp({ db: createDb(config.env.SUPABASE_URL, config.env.SUPABASE_SERVICE_KEY), config }, { logger: true });
await app.listen({ port: config.env.PORT, host: '0.0.0.0' });
