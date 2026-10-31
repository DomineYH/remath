// psql 연결(#87): SUPABASE_DB_URL 은 DB 비밀번호를 담는다. argv 에 두면 psql 이 도는 동안 `ps` 로 보이므로 libpq env(PGHOST…PGPASSWORD)로 넘긴다.
// PGDATABASE 에 URI 를 넣는 방법은 안 된다: libpq 는 그것을 이름 그대로 쓴다(dbname 인자만 URI 를 펼친다).
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

// URL 쿼리 중 받는 것. 나머지는 조용히 버리지 않고 멈춘다(argv 형태는 libpq 가 전부 읽었다).
const QUERY: Record<string, string> = { sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', connect_timeout: 'PGCONNECT_TIMEOUT', application_name: 'PGAPPNAME' };

/** 오류 메시지에는 URL·비밀번호를 넣지 않는다. */
const bad = (why: string) => new Error(`SUPABASE_DB_URL ${why}`);
const decode = (s: string) => { try { return decodeURIComponent(s); } catch { throw bad('has invalid percent-encoding'); } };

/**
 * postgres:// URL → libpq env. 포트 기본 5432, DB 기본 postgres.
 * sslmode 기본은 require: argv 형태는 libpq 기본(prefer)이었지만 대상은 늘 Supabase(TLS 지원)라 평문으로 내려가지 않게 막는다.
 */
export function pgEnv(dbUrl: string): Record<string, string> {
  let u: URL;
  try { u = new URL(dbUrl); } catch { throw bad('is not a valid URL'); }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw bad('must start with postgres:// or postgresql://');
  if (!u.hostname) throw bad('has no host');
  const env: Record<string, string> = {
    PGHOST: u.hostname.replace(/^\[(.*)\]$/, '$1'), PGPORT: u.port || '5432',
    PGDATABASE: decode(u.pathname.slice(1)) || 'postgres', PGSSLMODE: 'require',
  };
  if (u.username) env.PGUSER = decode(u.username);
  if (u.password) env.PGPASSWORD = decode(u.password);
  for (const [k, v] of u.searchParams) {
    if (!(k in QUERY)) throw bad(`has an unsupported query parameter: ${k}`);
    env[QUERY[k]] = v;
  }
  return env;
}

/**
 * psql 자식의 env: 물려받은 PG* 는 모두 뺀다(PGSERVICE 의 서비스 파일 값은 PGHOST 같은 env 보다 우선해 다른 DB 로 붙을 수 있다).
 * SUPABASE_DB_URL 도 넘기지 않는다(psql 은 읽지 않는다).
 */
export function psqlEnv(dbUrl: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith('PG') && k !== 'SUPABASE_DB_URL'));
  return { ...env, ...pgEnv(dbUrl) };
}

/** spawnSync('psql', args) — 연결은 env 로만. args 에 URL 을 넣지 않는다. */
export const spawnPsql = (dbUrl: string, args: string[], opts: SpawnSyncOptionsWithStringEncoding) =>
  spawnSync('psql', args, { ...opts, env: psqlEnv(dbUrl) });
