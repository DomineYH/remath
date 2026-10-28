// SQLite 백업 CLI (H-29 6단계, H-30): `npm run backup -w server` → BACKUP_DIR/remath-<YYYYMMDD>.sqlite.
// 운영에서는 컨테이너 안에서 돈다(deploy.sh 6단계 = docker compose exec): 컨테이너의 env·볼륨을 그대로 쓴다.
import { z } from 'zod';
import { backup, BackupEnv } from '../backup.ts';
import { createDb } from '../db.ts';
import { main, readEnv } from './main.ts';

const Env = BackupEnv.extend({ SUPABASE_URL: z.url(), SUPABASE_SERVICE_KEY: z.string().min(1) });

if (import.meta.main) main('backup', async () => {
  const env = readEnv(Env, process.env);
  const r = await backup(createDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY), { dir: env.BACKUP_DIR, keep: env.BACKUP_KEEP });
  // rows = 읽은 행 수. pruned = 그중 도는 중 부모 없이 들어와 파일에서 정리한 행 수.
  if (Object.keys(r.pruned).length) console.warn(`backup pruned orphan rows written during the run: ${JSON.stringify(r.pruned)}`);
  console.log(`backup ok ${r.file} ${JSON.stringify(r.rows)}`);
});
