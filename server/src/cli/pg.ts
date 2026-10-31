// psql 연결(#87): SUPABASE_DB_URL 은 DB 비밀번호를 담는다. argv 에 두면 psql 이 도는 동안 `ps` 로 보이므로 libpq env(PGHOST…PGPASSWORD)로 넘긴다.
// PGDATABASE 에 URI 를 넣는 방법은 안 된다: libpq 는 그것을 이름 그대로 쓴다(dbname 인자만 URI 를 펼친다).
import { spawnSync } from 'node:child_process';

// URL 쿼리 중 받는 것(Map: constructor·__proto__ 같은 상속 이름이 통과하지 않게). 나머지는 조용히 버리지 않고 멈춘다(argv 형태는 libpq 가 전부 읽었다).
const QUERY = new Map([['sslmode', 'PGSSLMODE'], ['sslrootcert', 'PGSSLROOTCERT'], ['connect_timeout', 'PGCONNECT_TIMEOUT'], ['application_name', 'PGAPPNAME'], ['options', 'PGOPTIONS']]);

/** 오류 메시지는 상수다: URL 에서 온 글자(값·쿼리 키 포함)를 넣지 않는다. field 는 우리 쪽 이름만. */
const bad = (why: string) => new Error(`SUPABASE_DB_URL ${why}`);
const decode = (s: string) => { try { return decodeURIComponent(s); } catch { throw bad('has invalid percent-encoding'); } };
/** Node 는 NUL 이 든 env 값을 거부하며 그 값을 오류 메시지에 담는다: spawn 전에 막는다. */
const checked = (field: string, v: string) => { if (v.includes('\0')) throw bad(`${field} contains a NUL byte`); return v; };
/** C0 제어 문자(NUL 포함)와 DEL. */
const hasControl = (v: string) => [...v].some(c => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const noControl = (field: string, v: string) => { if (hasControl(v)) throw bad(`${field} contains a control character`); return v; };

// 값 검사(spawn 전): libpq 는 잘못된 값을 psql 오류에 그대로 찍는다("invalid sslmode value: \"…\""). 메시지는 매개변수 이름만.
const SSLMODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'];
const VALID: Record<string, (v: string) => boolean> = {
  sslmode: v => SSLMODES.includes(v),
  connect_timeout: v => /^\d+$/.test(v),
  application_name: v => !hasControl(v), options: v => !hasControl(v), sslrootcert: v => !hasControl(v),
};

/** URL → libpq env 와, psql 출력에서 가릴 값들(복호한 비밀번호·인코딩된 비밀번호·URL 전체·복호한 쿼리 값). */
function parse(dbUrl: string) {
  let u: URL;
  try { u = new URL(dbUrl); } catch { throw bad('is not a valid URL'); }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw bad('must start with postgres:// or postgresql://');
  if (!u.hostname) throw bad('has no host');
  const env: Record<string, string> = {
    // libpq 는 호스트도 %-복호한다(%64b.x → db.x).
    PGHOST: noControl('host', decode(u.hostname.replace(/^\[(.*)\]$/, '$1'))), PGPORT: u.port || '5432',
    PGDATABASE: checked('database', decode(u.pathname.slice(1))) || 'postgres', PGSSLMODE: 'require',
  };
  const secrets = [dbUrl];
  if (u.username) env.PGUSER = checked('user', decode(u.username));
  if (u.password) secrets.push(u.password, env.PGPASSWORD = checked('password', decode(u.password)));
  for (const pair of u.search.slice(1).split('&').filter(Boolean)) {
    const i = pair.indexOf('='), key = decode(i < 0 ? pair : pair.slice(0, i)), name = QUERY.get(key);
    if (!name || i < 0) throw bad(`has an unsupported query parameter; allowed: ${[...QUERY.keys()].join(', ')}`);
    const v = checked(`query parameter ${name}`, decode(pair.slice(i + 1)));
    if (!VALID[key](v)) throw bad(`query parameter ${key} has an invalid value`);
    secrets.push(env[name] = v);
  }
  return { env, secrets };
}

/**
 * postgres:// URL → libpq env. 포트 기본 5432, DB 기본 postgres.
 * sslmode 기본은 require: argv 형태는 libpq 기본(prefer)이었지만 대상은 늘 Supabase(TLS 지원)라 평문으로 내려가지 않게 막는다.
 * 쿼리는 libpq 처럼 직접 푼다(URLSearchParams 는 + 를 공백으로 바꾼다; libpq 는 % 만 푼다).
 */
export const pgEnv = (dbUrl: string) => parse(dbUrl).env;

/** psql 출력에서 URL 에서 온 비밀 후보를 *** 로. 4자 미만은 흔한 낱말을 망가뜨리므로 두고, 긴 것부터(URL 이 비밀번호보다 먼저). */
export function redactor(dbUrl: string) {
  const hide = [...new Set(parse(dbUrl).secrets.filter(s => s.length >= 4))].sort((a, b) => b.length - a.length);
  return (text: string) => hide.reduce((t, s) => t.split(s).join('***'), text);
}

/**
 * psql 자식의 env: 물려받은 PG* 는 모두 뺀다(PGSERVICE 의 서비스 파일 값은 PGHOST 같은 env 보다 우선해 다른 DB 로 붙을 수 있다).
 * SUPABASE_DB_URL 도 넘기지 않는다(psql 은 읽지 않는다).
 */
export function psqlEnv(dbUrl: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith('PG') && k !== 'SUPABASE_DB_URL'));
  return { ...env, ...pgEnv(dbUrl) };
}

/** 실행 실패는 코드·이름만: Node 의 메시지는 env·인자 값을 담을 수 있다. */
const startFailed = (err: unknown) => {
  const { code, name } = (err ?? {}) as { code?: unknown; name?: unknown };
  const id = [code, name].find((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_]+$/.test(x)) ?? 'unknown error';
  return new Error(`psql could not be started: ${id}`);
};

/**
 * spawnSync('psql', args) — 연결은 env 로만. args 에 URL 을 넣지 않는다. 시작하지 못하면(없음·잘못된 인자) 상수 메시지로 throw.
 * stderr 는 받아 두었다가 비밀 후보를 가려 부모 stderr 로 낸다(psql 오류는 연결 값을 되찍을 수 있다). stdout 은 'pipe'(결과로) 또는 'inherit'.
 */
export function spawnPsql(dbUrl: string, args: string[], o: { stdout: 'pipe' | 'inherit'; input?: string }) {
  const env = psqlEnv(dbUrl), redact = redactor(dbUrl);
  let r;
  try {
    r = spawnSync('psql', args, { env, input: o.input, encoding: 'utf8', maxBuffer: 1 << 30, stdio: [o.input === undefined ? 'ignore' : 'pipe', o.stdout, 'pipe'] });
  } catch (err) { throw startFailed(err); }
  if (r.stderr) process.stderr.write(redact(r.stderr));
  if (r.error) throw startFailed(r.error);
  return r;
}
