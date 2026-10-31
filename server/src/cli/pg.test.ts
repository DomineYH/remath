// #87: psql 연결 정보는 argv 가 아니라 libpq env 로 간다(ps 로 비밀번호가 보이지 않게). 가짜 psql 이 받은 인자·env 를 남긴다.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TABLES } from '../backup.ts';
import { migrate, runPsql } from './migrate.ts';
import { pgEnv, psqlEnv } from './pg.ts';
import { restore, runPsqlIn } from './restore.ts';

const PASS = 'p@ss:w/rd?#%&!\'()* 비번';
const URL_ = `postgresql://postgres.abcref:${encodeURIComponent(PASS)}@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require`;
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
  it('sslmode from the query wins over the default', () => {
    expect(pgEnv('postgres://u:p@h/db?sslmode=verify-full').PGSSLMODE).toBe('verify-full');
    expect(pgEnv('postgres://u:p@h/my%20db').PGDATABASE).toBe('my db');
  });
  it('no password in the URL → no PGPASSWORD (libpq may still use ~/.pgpass)', () => {
    expect(pgEnv('postgres://u@h/db')).not.toHaveProperty('PGPASSWORD');
  });
  it.each([
    ['not a URL', 'pass-secret-1 not a url'],
    ['wrong scheme', 'mysql://u:pass-secret-1@h/db'],
    ['no host', 'postgres://u:pass-secret-1@/db'],
    ['bad percent-encoding', 'postgres://u:pass-secret-1%zz@h/db'],
    ['unsupported query parameter', 'postgres://u:pass-secret-1@h/db?options=-c%20x'],
  ])('%s: throws without the URL or the password in the message', (_, url) => {
    let msg = '';
    try { pgEnv(url); } catch (err) { msg = (err as Error).message; }
    expect(msg).toMatch(/^SUPABASE_DB_URL/);
    expect(msg).not.toContain('pass-secret-1');
    expect(msg).not.toContain(url);
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
