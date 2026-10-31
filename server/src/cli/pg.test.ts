// #87: psql 연결 정보는 argv 가 아니라 libpq env 로 간다(ps 로 비밀번호가 보이지 않게). 가짜 psql 이 받은 인자·env 를 남긴다.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TABLES } from '../backup.ts';
import { migrate, runPsql } from './migrate.ts';
import { pgEnv, psqlEnv, spawnPsql } from './pg.ts';
import { restore, runPsqlIn } from './restore.ts';

const PASS = 'p@ss:w/rd?#%&!\'()* 비번';
const URL_ = `postgresql://postgres.abcref:${encodeURIComponent(PASS)}@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require`;
const MARK = 'synthetic-secret-marker';
const encodeAll = (s: string) => [...s].map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
const SECRETS = [URL_, PASS, encodeURIComponent(PASS), 'aws-1-ap-northeast-2.pooler.supabase.com', 'postgres.abcref'];

describe('pgEnv', () => {
  it('turns a Supabase URL into libpq env vars (percent-decoded user and password)', () => {
    expect(pgEnv(URL_)).toEqual({
      PGHOST: 'aws-1-ap-northeast-2.pooler.supabase.com', PGPORT: '5432', PGDATABASE: 'postgres',
      PGUSER: 'postgres.abcref', PGPASSWORD: PASS, PGSSLMODE: 'require',
    });
  });
  it('defaults: port 5432, database postgres, sslmode require', () => {
    expect(pgEnv('postgres://u:p@h')).toEqual({ PGHOST: 'h', PGPORT: '5432', PGDATABASE: 'postgres', PGUSER: 'u', PGPASSWORD: 'p', PGSSLMODE: 'require' });
    expect(pgEnv('postgres://u:p@h:6000/')).toMatchObject({ PGPORT: '6000', PGDATABASE: 'postgres' });
  });
  it('options= → PGOPTIONS, decoded like libpq (only %, a + stays a +)', () => {
    expect(pgEnv('postgres://u:p@h/db?options=-c%20statement_timeout%3D5000&application_name=a+b')).toMatchObject({ PGOPTIONS: '-c statement_timeout=5000', PGAPPNAME: 'a+b' });
  });
  it('sslmode from the query wins over the default', () => {
    expect(pgEnv('postgres://u:p@h/db?sslmode=verify-full').PGSSLMODE).toBe('verify-full');
    expect(pgEnv('postgres://u:p@h/my%20db').PGDATABASE).toBe('my db');
  });
  it('no password in the URL → no PGPASSWORD (libpq may still use ~/.pgpass)', () => {
    expect(pgEnv('postgres://u@h/db')).not.toHaveProperty('PGPASSWORD');
  });
  /** 오류 메시지가 상수인지: 표지(MARK)·URL 어느 것도 들어 있지 않다. */
  const errorOf = (url: string) => { try { pgEnv(url); } catch (err) { return (err as Error).message; } throw new Error('did not throw'); };
  it.each([
    ['not a URL', `${MARK} not a url`],
    ['wrong scheme', `mysql://u:${MARK}@h/db`],
    ['no host', `postgres://u:${MARK}@/db`],
    ['bad percent-encoding', `postgres://u:${MARK}%zz@h/db`],
    ['unsupported query key', `postgres://u:${MARK}@h/db?${MARK}=1`],
    ['unsupported query key, percent-encoded', `postgres://u:${MARK}@h/db?${encodeAll(MARK)}=1`],
    ['query key without a value', `postgres://u:${MARK}@h/db?sslmode`],
    ['NUL in the password', `postgres://u:${MARK}%00@h/db`],
    ['NUL in the user', `postgres://${MARK}%00:p@h/db`],
    ['NUL in the database', `postgres://u:p@h/${MARK}%00`],
    ['NUL in a query value', `postgres://u:p@h/db?options=${MARK}%00`],
  ])('%s: throws a constant message (no URL-derived text)', (_, url) => {
    const msg = errorOf(url);
    expect(msg).toMatch(/^SUPABASE_DB_URL /);
    expect(msg).not.toContain(MARK);
    expect(msg).not.toContain(url);
  });
  it('NUL errors name the field only; unsupported keys list what is allowed', () => {
    expect(errorOf(`postgres://u:${MARK}%00@h/db`)).toBe('SUPABASE_DB_URL password contains a NUL byte');
    expect(errorOf(`postgres://u:p@h/db?x=1`)).toBe('SUPABASE_DB_URL has an unsupported query parameter; allowed: sslmode, sslrootcert, connect_timeout, application_name, options');
  });
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('inherited name %s is not an allowed parameter', k => {
    expect(errorOf(`postgres://u:p@h/db?${k}=1`)).toMatch(/unsupported query parameter/);
  });
});

describe('psqlEnv', () => {
  it('drops inherited PG* (a PGSERVICE would override our host) and SUPABASE_DB_URL, keeps the rest', () => {
    const env = psqlEnv(URL_, { PATH: '/bin', PGSERVICE: 'other', PGSERVICEFILE: '/x', PGHOSTADDR: '10.0.0.1', PGHOST: 'elsewhere', SUPABASE_DB_URL: URL_, HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', ...pgEnv(URL_) });
  });
});

describe('real spawn: the fake psql sees no secret in argv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-test-')), log = join(dir, 'log');
  writeFileSync(join(dir, 'psql'), `#!/bin/sh
printf '%s\\n' "$@" >> "${log}.args"; env > "${log}.env"; cat > /dev/null
case "$*" in *to_regclass*) echo t ;; *schema_migrations*) echo 0001 ;; esac
`);
  chmodSync(join(dir, 'psql'), 0o755);
  const read = (f: string) => readFileSync(`${log}.${f}`, 'utf8');
  const check = () => {
    const args = read('args'), env = read('env').split('\n');
    for (const s of SECRETS) expect(args, s).not.toContain(s);
    for (const [k, v] of Object.entries(pgEnv(URL_))) expect(env, k).toContain(`${k}=${v}`);
    expect(env.filter(l => /^(SUPABASE_DB_URL|PGSERVICE)=/.test(l))).toEqual([]);
  };
  const stub = () => {
    writeFileSync(`${log}.args`, '');
    vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
    vi.stubEnv('SUPABASE_DB_URL', URL_);
    vi.stubEnv('PGSERVICE', 'wrong-db');
  };
  afterEach(() => { vi.unstubAllEnvs(); });

  it('db:migrate: both the queries and the -f runs', () => {
    stub();
    expect(migrate(runPsql(URL_), ['0001_init.sql', '0002_x.sql'], '/m/')).toEqual({ applied: ['0001'], ran: ['0002_x.sql'] });
    expect(read('args')).toContain('/m/0002_x.sql');
    check();
  });

  it('db:restore --load', () => {
    stub();
    const f = join(dir, 'b.sqlite'), sq = new Database(f);
    for (const [t, cols] of Object.entries(TABLES)) sq.exec(`create table "${t}" (${cols.map(c => `"${c.name}"`).join(', ')})`);
    sq.close();
    restore(f, runPsqlIn(URL_));
    expect(read('args')).toContain('--single-transaction');
    check();
  });
});

// #87 rev 2 회귀: 잘못된 URL·시작 실패가 어떤 경로로도 비밀을 내보내지 않는다(실제 db:migrate 진입점과 runPsql·runPsqlIn).
describe('error paths leak no secret', () => {
  const SHAPES = [
    `postgres://u:${MARK}%00@h:5432/postgres`,
    `postgres://u:${MARK}@h:5432/postgres?${MARK}=1`,
    `postgres://u:${MARK}@h:5432/postgres?${encodeAll(MARK)}=1`,
    `postgres://u:${MARK}@h:5432/postgres?constructor=1`,
  ];
  const fakeBin = mkdtempSync(join(tmpdir(), 'pg-leak-'));
  writeFileSync(join(fakeBin, 'psql'), '#!/bin/sh\necho "psql reached" >&2; exit 3\n'); chmodSync(join(fakeBin, 'psql'), 0o755);
  const SERVER = fileURLToPath(new URL('../../', import.meta.url));

  it.each(SHAPES)('npm run db:migrate entry with %s: exit 1, marker in neither stdout nor stderr, psql never started', url => {
    const r = spawnSync(process.execPath, ['--import', './src/raw-hooks.ts', 'src/cli/migrate.ts'],
      { cwd: SERVER, encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, SUPABASE_DB_URL: url } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^db:migrate failed: SUPABASE_DB_URL /);
    expect(r.stdout + r.stderr).not.toContain(MARK);
    expect(r.stderr).not.toContain('psql reached');
  });

  it.each(SHAPES)('runPsql / runPsqlIn with %s: thrown message has no marker', url => {
    for (const run of [() => runPsql(url)(['-c', 'select 1']), () => runPsqlIn(url)(['-f', '-'], '')]) {
      expect(run).toThrow(/^SUPABASE_DB_URL /);
      try { run(); } catch (err) { expect((err as Error).message).not.toContain(MARK); }
    }
  });

  it('a spawn that Node refuses (NUL in an argument) reports only the error code', () => {
    expect(() => spawnPsql('postgres://u:p@h/db', [`${MARK}\0`], { encoding: 'utf8' })).toThrow(/^psql could not be started: ERR_INVALID_ARG_VALUE$/);
  });
  it('psql missing from PATH reports only the error code', () => {
    vi.stubEnv('PATH', fakeBin + '-does-not-exist');
    try { expect(() => spawnPsql(`postgres://u:${MARK}@h/db`, [], { encoding: 'utf8' })).toThrow(/^psql could not be started: ENOENT$/); } finally { vi.unstubAllEnvs(); }
  });
});
