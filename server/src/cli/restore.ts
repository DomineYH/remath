// 복구 3단계 (H-31, O-5 A): SQLite 백업(backup.ts)을 FK 순서로 `psql \copy` 해 새 프로젝트에 넣는다. 전부 한 트랜잭션(--single-transaction).
// auth_sessions·schema_migrations 는 넣지 않는다(백업에 없다). ai_settings.key_ciphertext 는 백업에 없어 null 로 남는다(키 재등록 대상).
// 트리거는 모두 before update 라 넣은 값(created_at·updated_at)을 바꾸지 않는다. 시퀀스·identity 는 없다(키는 uuid; restore.test.ts 가 본다).
// 실행(scripts/restore.sh → deploy.sh --restore):
//   npm run db:restore -w server -- --check <file>   파일이 백업 모양인지 보고 테이블별 행 수를 찍는다(프로젝트를 만들기 전).
//   npm run db:restore -w server -- --load <file>    SUPABASE_DB_URL 에 넣는다.
import Database from 'better-sqlite3';
import { z } from 'zod';
import { TABLES } from '../backup.ts';
import { main, readEnv } from './main.ts';
import { DbUrl } from './migrate.ts';
import { spawnPsql } from './pg.ts';

export const ORDER = Object.keys(TABLES);   // backup.ts 의 테이블 순서 = H-31 복구 순서

/** 읽기 전용으로 열고 10개 테이블·열이 다 있는지 본다. 백업이 아닌 파일은 여기서 실패한다. */
function open(file: string) {
  const sq = new Database(file, { readonly: true, fileMustExist: true });
  try {
    let tables: string[];
    try { tables = sq.prepare(`select name from sqlite_master where type = 'table'`).pluck().all() as string[]; } catch (err) {
      throw new Error(`${file} is not a readable SQLite backup (${(err as Error).message})`);
    }
    for (const t of ORDER) {
      if (!tables.includes(t)) throw new Error(`${file}: table ${t} is missing`);
      const cols = sq.prepare(`select name from pragma_table_info(?)`).pluck().all(t) as string[];
      for (const c of TABLES[t]) if (!cols.includes(c.name)) throw new Error(`${file}: column ${t}.${c.name} is missing`);
    }
    return sq;
  } catch (err) { sq.close(); throw err; }
}

export function backupCounts(file: string) {
  const sq = open(file);
  try { return Object.fromEntries(ORDER.map(t => [t, sq.prepare(`select count(*) from "${t}"`).pluck().get() as number])); } finally { sq.close(); }
}

// COPY text 형식: 열은 탭, 행은 \n, null 은 \N. 값 안의 \ 탭 \n \r 만 이스케이프하면 나머지(따옴표·유니코드)는 그대로다.
const esc = (s: string) => s.replace(/[\\\t\n\r]/g, ch => ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' })[ch]!);
export function copyText(table: string, rows: Record<string, unknown>[]) {
  return rows.map(r => TABLES[table].map(c => {
    const v = r[c.name];
    return v === null || v === undefined ? '\\N' : c.type === 'bool' ? (v ? 't' : 'f') : esc(String(v));   // json = JSON 문자열 그대로 → jsonb
  }).join('\t') + '\n').join('');
}

export type Step = { sql: string } | { table: string; cols: string[]; data: string };

/** 트랜잭션 안에서 돌 단계들: 대상이 비었는지 확인 → 테이블마다 COPY. psql 과 테스트(PGlite)가 같은 단계를 쓴다. */
export function restoreSteps(file: string): Step[] {
  const sq = open(file);
  try {
    // 새 프로젝트(마이그레이션만 적용)가 아니면 덮어쓰지 않고 멈춘다.
    const guard = `do $$ declare t text; has boolean; nonempty text[] := '{}'; begin
  foreach t in array array['${ORDER.join("','")}'] loop
    execute format('select exists (select 1 from %I)', t) into has;
    if has then nonempty := nonempty || t; end if;
  end loop;
  if cardinality(nonempty) > 0 then raise exception 'restore target is not empty: %', array_to_string(nonempty, ', '); end if;
end $$;`;
    return [{ sql: guard }, ...ORDER.map(t => ({
      table: t, cols: TABLES[t].map(c => c.name),
      data: copyText(t, sq.prepare(`select ${TABLES[t].map(c => `"${c.name}"`).join(', ')} from "${t}"`).all() as Record<string, unknown>[]),
    }))];
  } finally { sq.close(); }
}

export const psqlScript = (steps: Step[]) => '\\encoding UTF8\n' + steps.map(s => 'sql' in s ? `${s.sql}\n`
  : `\\copy "${s.table}" (${s.cols.map(c => `"${c}"`).join(', ')}) from stdin\n${s.data}\\.\n`).join('');

/** psql(args, stdin). 연결 정보는 args 가 아니라 runPsqlIn 이 env 로 준다. 0 이 아닌 종료는 throw. */
export type PsqlIn = (args: string[], input: string) => void;

/**
 * 스크립트는 stdin 으로만 넘긴다(비밀번호 해시가 디스크에 남지 않게). VERBOSITY=terse: 제약 위반의 DETAIL("Failing row contains …")에
 * 해시가 찍히지 않게 한 줄 메시지만. ponytail: 백업 전체를 메모리 문자열로 만든다; 파일이 수백 MB 가 되면 테이블별 스트리밍으로.
 */
export function restore(file: string, psql: PsqlIn) {
  const counts = backupCounts(file);
  psql(['-X', '-q', '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse', '-f', '-'], psqlScript(restoreSteps(file)));
  return counts;
}

export const runPsqlIn = (dbUrl: string): PsqlIn => (args, input) => {
  const r = spawnPsql(dbUrl, args, { stdout: 'inherit', input });
  if (r.status !== 0) throw new Error(`psql exited ${r.status}; nothing was loaded (one transaction)`);
};

if (import.meta.main) main('db:restore', async () => {
  const [mode, file] = process.argv.slice(2);
  if (!file || (mode !== '--check' && mode !== '--load')) throw new Error('usage: npm run db:restore -w server -- --check|--load <file>');
  if (mode === '--check') return console.log(`db:restore check ok ${file} ${JSON.stringify(backupCounts(file))}`);
  const counts = restore(file, runPsqlIn(readEnv(z.object({ SUPABASE_DB_URL: DbUrl }), process.env).SUPABASE_DB_URL));
  console.log(`db:restore ok ${JSON.stringify(counts)}`);
});
