// 마이그레이션 (D-15, H-29 2단계): db/migrations/NNNN_<name>.sql 을 번호 순으로, schema_migrations 에 없는 것만
// `psql "$SUPABASE_DB_URL" --single-transaction -v ON_ERROR_STOP=1 -f` 로 적용한다. 하나라도 실패하면 거기서 멈춘다.
// 실행: `npm run db:migrate -w server` (deploy.sh 2단계).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { main, readEnv } from './main.ts';

const DIR = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));

/** 적용할 파일(번호 순). 마이그레이션이 아닌 파일(*.test.ts 등)은 무시한다. */
export const pending = (files: string[], applied: string[]) =>
  files.filter(f => /^\d{4}_\w+\.sql$/.test(f)).sort().filter(f => !applied.includes(f.slice(0, 4)));

/** psql(args) → stdout. 0 이 아닌 종료는 throw. */
export type Psql = (args: string[]) => string;

export function migrate(dbUrl: string, psql: Psql, files = readdirSync(DIR), dir = DIR) {
  const q = (sql: string) => psql([dbUrl, '-X', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql]).trim();
  // 빈 프로젝트에는 schema_migrations 가 아직 없다(0001 이 만든다).
  const applied = q(`select to_regclass('public.schema_migrations') is not null`) === 't'
    ? q('select version from schema_migrations order by 1').split('\n').filter(Boolean) : [];
  const todo = pending(files, applied);
  for (const f of todo) psql([dbUrl, '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', dir + f]);
  return { applied, ran: todo };
}

const runPsql: Psql = args => {
  const r = spawnSync('psql', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.error) throw new Error(`psql not runnable: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`psql exited ${r.status}${args.includes('-f') ? ` on ${args.at(-1)}` : ''}`);
  return r.stdout;
};

// Transaction pooler(6543)는 --single-transaction 과 세션 상태를 보장하지 않는다(B절: Direct 5432 또는 Session pooler).
export const DbUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string').refine(u => !/:6543\b/.test(u), 'transaction pooler (port 6543) is not allowed');
const Env = z.object({ SUPABASE_DB_URL: DbUrl });

if (import.meta.main) main('db:migrate', async () => {
  const { applied, ran } = migrate(readEnv(Env, process.env).SUPABASE_DB_URL, runPsql);
  console.log(`db:migrate ok applied before: [${applied.join(', ')}], ran now: [${ran.join(', ')}]`);
});
