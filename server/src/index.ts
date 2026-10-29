// 기동: 검증(fail-fast) → 앱 → listen. 실행은 `npm run start -w server`(raw-hooks 필요, package.json).
import { readFileSync } from 'node:fs';
import { buildApp } from './app.ts';
import { backup, BackupEnv, scheduleBackups } from './backup.ts';
import { readEnv } from './cli/main.ts';
import { loadConfig, type Config } from './config.ts';
import { createDb } from './db.ts';
import { providersFor } from './providers/index.ts';
import { releaseTurns } from './turn.ts';

const ROOT = new URL('../../', import.meta.url);
let config: Config, backupEnv: ReturnType<typeof BackupEnv.parse>;
try {
  config = loadConfig(process.env, path => readFileSync(new URL(path, ROOT), 'utf8'));
  backupEnv = readEnv(BackupEnv, process.env);
} catch (err) {
  console.error(`remath server refused to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
const db = createDb(config.env.SUPABASE_URL, config.env.SUPABASE_SERVICE_KEY);
await releaseTurns(db);
const app = await buildApp({ db, config, providersFor }, { logger: true });
app.log.info(`llm: ${config.env.MOCK_LLM === '0' ? 'live' : 'mock'}`);
await app.listen({ port: config.env.PORT, host: '0.0.0.0' });
// 매일 SQLite 백업(H-30): 실패는 로그에만 남고 서비스는 그대로다.
scheduleBackups({
  at: backupEnv.BACKUP_AT,
  run: async () => {
    const r = await backup(db, { dir: backupEnv.BACKUP_DIR, keep: backupEnv.BACKUP_KEEP });
    if (Object.keys(r.pruned).length) app.log.warn({ pruned: r.pruned }, 'backup pruned orphan rows written during the run');
    app.log.info({ backup: r }, 'backup ok');
  },
  log: err => app.log.error({ err }, 'backup failed'),
});
