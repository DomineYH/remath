// scripts/deploy.sh 의 순서·멈춤과 deploy/compose.yaml 의 설정을 고정한다. npm·docker·curl·psql 은 가짜; 실 psql·Docker 는 수동(T-4).
// env 파일 교체 자체는 env-swap.test.ts 가 본다.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/deploy.sh');

// 가짜 도구는 받은 인자를 $LOG 에 남긴다. FAIL = 실패시킬 호출의 일부 문자열(예: db:smoke, "compose -f deploy/compose.yaml up").
const STUBS: Record<string, string> = {
  node: 'exit 0', psql: 'exit 0',
  // db:new-project 는 마지막 인자(deploy.sh 의 임시 env 파일)에 NEW_ENV 를 쓰고 경로를 $LOG.tmp, env 를 $LOG.newenv 에 남긴다. 나머지 호출의 env 는 $LOG.env 로.
  npm: 'echo "npm $* REMATH_ENV_FILE=$REMATH_ENV_FILE" >> "$LOG"; case "$*" in *db:restore*) [ -n "${ADMIN_INITIAL_PASSWORD:-}" ] && echo "ADMIN_INITIAL_PASSWORD reached $*" >> "$LOG" ;; esac; case "$*" in *db:new-project*) for a; do out="$a"; done; echo "$out" > "$LOG.tmp"; env >> "$LOG.newenv";'
    + ' [ "$FAIL" = db:new-project ] && exit 1; printf "$NEW_ENV" > "$out"; exit 0 ;; esac; env >> "$LOG.env"; case "$*" in *"$FAIL"*) [ -n "$FAIL" ] && exit 1 ;; esac; exit 0',
  docker: 'echo "docker $*" >> "$LOG"; env >> "$LOG.env"; case "$*" in *"$FAIL"*) [ -n "$FAIL" ] && exit 1 ;; esac; exit 0',
  curl: 'for a; do url="$a"; done; echo "curl $url" >> "$LOG"; case "$url" in */healthz) printf 200 ;; */api/auth/me) printf "${ME_CODE:-401}" ;; esac',
};
const NEW = { SUPABASE_URL: 'https://new.supabase.co', SUPABASE_SERVICE_KEY: 'new-service', SUPABASE_DB_URL: 'postgres://u:p@new:5432/postgres', SUPABASE_ANON_KEY: 'new-anon' };

function deploy(args: string[] = [], extra: Record<string, string> = {}, script = SCRIPT, serverEnv = 'MOCK_LLM=1\n') {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-test-')), bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); }
  writeFileSync(join(dir, 'server.env'), serverEnv, { mode: 0o600 });
  writeFileSync(join(dir, 'remath-20261028.sqlite'), '');   // restore.sh 의 백업 파일(가짜 npm 은 읽지 않는다)
  const log = join(dir, 'log');
  writeFileSync(log, '');
  // REMATH_ENV_FILE 는 상대 경로로 준다: deploy.sh 가 절대 경로로 바꿔 넘겨야 한다.
  const r = spawnSync('bash', [script, ...args], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, LOG: log, REMATH_ENV_FILE: 'server.env', ADMIN_INITIAL_PASSWORD: 'admin1234', ...NEW, ...extra },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  const read = (f: string) => existsSync(f) ? readFileSync(f, 'utf8') : '';
  return { ...r, dir, calls, steps: calls.filter(c => !/^docker (info|compose version)|^curl/.test(c)), childEnv: read(`${log}.env`), newEnv: read(`${log}.newenv`), tmp: read(`${log}.tmp`).trim() };
}

describe('scripts/deploy.sh', () => {
  it('is committed executable', () => {
    expect(execFileSync('git', ['ls-files', '-s', 'scripts/deploy.sh'], { cwd: ROOT, encoding: 'utf8' })).toMatch(/^100755 /);
  });

  it('migrate → seed → smoke → env:swap → compose up --force-recreate, then /healthz, the DB probe and the backup in the container', () => {
    const r = deploy(['--with-samples']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const env = `REMATH_ENV_FILE=${join(r.dir, 'server.env')}`;
    expect(r.steps).toEqual([
      'docker compose -f deploy/compose.yaml config -q',
      `npm run --silent db:migrate -w server ${env}`,
      `npm run --silent db:seed -w server -- --with-samples ${env}`,
      `npm run --silent db:smoke -w server -- --with-samples ${env}`,
      `npm run --silent env:swap -w server ${env}`,
      'docker compose -f deploy/compose.yaml up -d --force-recreate',
      'docker compose -f deploy/compose.yaml exec -T server npm run --silent backup',
    ]);
    expect(r.calls.filter(c => c.startsWith('curl'))).toEqual(['curl http://127.0.0.1:3000/healthz', 'curl http://127.0.0.1:3000/api/auth/me']);
    expect(r.stdout).toMatch(/new DB answers[\s\S]*== 6\/6 backup[\s\S]*deploy\.sh: ok\n$/);
  });

  it('a failed backup exits non-zero after the switch, with the retry command (H-29 6)', () => {
    const r = deploy([], { FAIL: 'npm run --silent backup' });
    expect(r.status).toBe(1);
    expect(r.steps.at(-1)).toMatch(/exec -T server npm run --silent backup$/);
    expect(r.stderr).toMatch(/backup failed \(the switch is done and the server is running\); retry: docker compose -f deploy\/compose\.yaml exec server npm run backup/);
  });

  it('checks the address compose binds to', () => {
    expect(deploy([], { REMATH_BIND: '10.0.0.5', REMATH_PORT: '8080' }).calls.filter(c => c.startsWith('curl'))[0]).toBe('curl http://10.0.0.5:8080/healthz');
    expect(deploy([], { REMATH_BIND: '0.0.0.0' }).calls.filter(c => c.startsWith('curl'))[0]).toBe('curl http://127.0.0.1:3000/healthz');
  });

  for (const step of ['db:migrate', 'db:seed', 'db:smoke', 'env:swap']) {
    it(`a failed ${step} stops before the env swap or the container is touched`, () => {
      const r = deploy([], { FAIL: step });
      expect(r.status).not.toBe(0);
      expect(r.steps.at(-1)).toMatch(step);
      expect(r.calls.some(c => c.includes(' up '))).toBe(false);
    });
  }

  it('a failed compose up or a server that cannot query the new DB fails with the rollback hint', () => {
    const up = deploy([], { FAIL: 'compose -f deploy/compose.yaml up' });
    expect(up.status).toBe(1);
    expect(up.stderr).toMatch(/docker compose up failed; roll back by hand: mv .*server\.env\.prev .*server\.env && docker compose -f deploy\/compose\.yaml up -d --force-recreate/);
    const db = deploy([], { ME_CODE: '500' });
    expect(db.status).toBe(1);
    expect(db.stderr).toMatch(/answered 500, want 401.*roll back by hand/);
  });

  it('an invalid compose config, an unknown option or a missing REMATH_ENV_FILE stop before any DB step', () => {
    const c = deploy([], { FAIL: 'config -q' });
    const u = deploy(['--bogus']);
    const m = deploy([], { REMATH_ENV_FILE: 'missing.env' });
    expect([c.status, u.status, m.status]).toEqual([1, 2, 1]);
    expect(u.stderr).toMatch(/unknown option --bogus \(usage: scripts\/deploy\.sh \[--new\] \[--with-samples\]\)/);
    expect(m.stderr).toMatch(/REMATH_ENV_FILE missing\.env is not a file/);
    for (const r of [c, u, m]) expect(r.calls.some(x => x.startsWith('npm'))).toBe(false);
  });
});

describe('scripts/deploy.sh --new (H-29 1, O-4)', () => {
  const TOKEN = 'sbp_token_must_not_leak';
  const MGMT = { SUPABASE_ACCESS_TOKEN: TOKEN, SUPABASE_ORG_ID: 'my-org', SUPABASE_REGION: 'ap-northeast-2', SUPABASE_DB_PASSWORD: 'db-pass' };
  const REF = 'abcdefghijklmnopqrst';
  const NEW_ENV = `SUPABASE_URL=https://${REF}.supabase.co\\nSUPABASE_SERVICE_KEY=s\\nSUPABASE_DB_URL=postgresql://postgres.${REF}:x@pooler:5432/postgres?sslmode=require\\nSUPABASE_ANON_KEY=a\\n`;
  // 셸에 이전 프로젝트의 SUPABASE_* 가 없어도 된다: 새 프로젝트에서 받는다.
  const deployNew = (args: string[] = [], extra: Record<string, string> = {}) =>
    deploy(['--new', ...args], { SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_DB_URL: '', SUPABASE_ANON_KEY: '', NEW_ENV, ...MGMT, ...extra });

  it('preflight → new project → migrate → seed → smoke → env:swap → compose up → backup, on the new project, without the token', () => {
    const r = deployNew(['--with-samples']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const env = `REMATH_ENV_FILE=${join(r.dir, 'server.env')}`;
    expect(r.calls.slice(0, 2)).toEqual(['docker info', 'docker compose version']);
    expect(r.steps).toEqual([
      'docker compose -f deploy/compose.yaml config -q',
      `npm run --silent db:new-project -w server -- ${r.tmp} ${env}`,
      `npm run --silent db:migrate -w server ${env}`,
      `npm run --silent db:seed -w server -- --with-samples ${env}`,
      `npm run --silent db:smoke -w server -- --with-samples ${env}`,
      `npm run --silent env:swap -w server ${env}`,
      'docker compose -f deploy/compose.yaml up -d --force-recreate',
      'docker compose -f deploy/compose.yaml exec -T server npm run --silent backup',
    ]);
    expect(r.stdout).toContain(`== 1/6 new Supabase project`);
    expect(r.stdout).toContain(`== 5/6 switch to https://${REF}.supabase.co`);
    // 이후 단계는 임시 env 의 새 값으로 돈다
    expect(r.childEnv).toContain(`SUPABASE_URL=https://${REF}.supabase.co\n`);
    expect(r.childEnv).toContain('SUPABASE_DB_URL=postgresql://postgres.');
    expect(r.childEnv).not.toContain(TOKEN);   // docker·compose·다른 npm 단계 어디에도
    expect(r.newEnv.split('\n').filter(l => l.includes(TOKEN))).toEqual([`SUPABASE_ACCESS_TOKEN=${TOKEN}`]);   // db:new-project 에만, 한 번
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(r.tmp).not.toBe('');
    expect(existsSync(r.tmp)).toBe(false);   // EXIT trap 이 지웠다
  });

  for (const [what, extra] of [
    ['SUPABASE_ACCESS_TOKEN', { SUPABASE_ACCESS_TOKEN: '' }], ['SUPABASE_ORG_ID', { SUPABASE_ORG_ID: '' }], ['SUPABASE_REGION', { SUPABASE_REGION: '' }],
    ['SUPABASE_DB_PASSWORD', { SUPABASE_DB_PASSWORD: '' }], ['ADMIN_INITIAL_PASSWORD', { ADMIN_INITIAL_PASSWORD: '' }],
    ['REMATH_ENV_FILE', { REMATH_ENV_FILE: 'missing.env' }], ['config -q', { FAIL: 'config -q' }], ['docker info', { FAIL: 'info' }],
  ] as const) {
    it(`a failed preflight (${what}) never creates a project`, () => {
      const r = deployNew([], extra);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(what === 'config -q' ? /compose\.yaml is invalid/ : what === 'docker info' ? /Docker daemon/ : new RegExp(what));
      expect(r.calls.some(c => c.startsWith('npm'))).toBe(false);
    });
  }

  it('a failed new-project stops there; the temp env file is removed', () => {
    const r = deployNew([], { FAIL: 'db:new-project' });
    expect(r.status).toBe(1);
    expect(r.steps.at(-1)).toMatch(/db:new-project/);
    expect(existsSync(r.tmp)).toBe(false);
  });

  it('a failed smoke keeps the env file and the container, and prints the new ref to delete by hand (H-29 4)', () => {
    const r = deployNew([], { FAIL: 'db:smoke' });
    expect(r.status).toBe(1);
    expect(r.steps.at(-1)).toMatch(/db:smoke/);
    expect(r.calls.some(c => c.includes('env:swap') || c.includes(' up '))).toBe(false);
    expect(readFileSync(join(r.dir, 'server.env'), 'utf8')).toBe('MOCK_LLM=1\n');
    expect(r.stderr).toMatch(new RegExp(`new Supabase project ${REF} is left in place.*delete it by hand`));
    expect(existsSync(r.tmp)).toBe(false);
  });

  it('after the switch a failure does not tell the operator to delete the project in use', () => {
    const r = deployNew([], { FAIL: 'npm run --silent backup' });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/delete it by hand/);
  });

  it('still rejects unknown options and stops before anything', () => {
    const r = deployNew(['--bogus']);
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
  });
});

// Q25: 런타임 env 파일이 MOCK_LLM=0 이면 KEY_VAULT_SECRET 이 32바이트여야 서버가 뜬다(vault.ts parseSecret) — 1단계 전에 멈춘다.
describe('scripts/deploy.sh KEY_VAULT_SECRET preflight (Q25)', () => {
  const B64 = Buffer.alloc(32, 7).toString('base64'), HEX = Buffer.alloc(32, 9).toString('hex'), SHORT = Buffer.alloc(16, 7).toString('base64');
  const MGMT = { SUPABASE_ACCESS_TOKEN: 't', SUPABASE_ORG_ID: 'o', SUPABASE_REGION: 'r', SUPABASE_DB_PASSWORD: 'p', NEW_ENV: '' };
  const live = (secret?: string) => `COOKIE_SECURE=false\nMOCK_LLM=0\n${secret === undefined ? '' : `KEY_VAULT_SECRET=${secret}\n`}`;

  for (const [what, body, msg] of [
    ['missing', live(), /KEY_VAULT_SECRET is not set/], ['empty', live(''), /KEY_VAULT_SECRET is not set/],
    ['16 bytes', live(SHORT), /KEY_VAULT_SECRET in .* is not 32 bytes \(base64 or 64 hex chars\)/], ['63 hex chars', live(HEX.slice(1)), /KEY_VAULT_SECRET in .* is not 32 bytes \(base64 or 64 hex chars\)/],
    ['not base64', live('!'.repeat(44)), /KEY_VAULT_SECRET in .* is not 32 bytes \(base64 or 64 hex chars\)/],
  ] as const) {
    it(`MOCK_LLM=0 with a ${what} secret stops before anything, with how to make one`, () => {
      for (const r of [deploy([], {}, SCRIPT, body), deploy(['--new'], MGMT, SCRIPT, body), deploy(['remath-20261028.sqlite'], MGMT, join(ROOT, 'scripts/restore.sh'), body)]) {
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(msg);
        expect(r.stderr).toMatch(/openssl rand -base64 32/);
        expect(r.steps).toEqual([]);   // compose config·db:restore --check·db:new-project 전
        if (body.includes('KEY_VAULT_SECRET=') && body !== live('')) expect(r.stderr).not.toContain(body.split('KEY_VAULT_SECRET=')[1].trim());
      }
    });
  }

  // 서버(config.ts)는 MOCK_LLM 이 정확히 '0'·'1' 이어야 뜬다. 사전 점검도 줄 끝 CR 하나만 떼고 같은 규칙.
  for (const [what, body] of [['padded', `MOCK_LLM= 0\nKEY_VAULT_SECRET=${B64}\n`], ['trailing space', `MOCK_LLM=1 \n`], ['not 0/1', 'MOCK_LLM=true\n'], ['missing', 'COOKIE_SECURE=false\n']] as const) {
    it(`MOCK_LLM ${what} stops before anything`, () => {
      for (const r of [deploy([], {}, SCRIPT, body), deploy(['--new'], MGMT, SCRIPT, body), deploy(['remath-20261028.sqlite'], MGMT, join(ROOT, 'scripts/restore.sh'), body)]) {
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/MOCK_LLM in .* must be exactly 0 or 1/);
        expect(r.steps).toEqual([]);
      }
    });
  }

  for (const [what, body] of [['base64', live(B64)], ['hex', live(HEX)], ['base64 with CRLF', live(`${B64}\r`)], ['MOCK_LLM=1 without a secret', 'MOCK_LLM=1\n'], ['MOCK_LLM=1 with CRLF', 'MOCK_LLM=1\r\n'], ['MOCK_LLM=0 with CRLF', `MOCK_LLM=0\r\nKEY_VAULT_SECRET=${B64}\r\n`]] as const) {
    it(`passes with ${what}`, () => {
      const r = deploy([], {}, SCRIPT, body);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    });
  }
});

describe('deploy/compose.yaml (the only container definition)', () => {
  const y = readFileSync(join(ROOT, 'deploy/compose.yaml'), 'utf8').split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
  it('binds to 127.0.0.1 by default and reads the runtime env file in raw format', () => {
    expect(y).toMatch(/^ {6}- "\$\{REMATH_BIND:-127\.0\.0\.1\}:\$\{REMATH_PORT:-3000\}:3000"$/m);
    // raw = 값 글자 그대로($VAR 치환 없음, Compose v2.30.0+). env-swap 은 이 형식으로 쓴다(env-swap.test.ts).
    expect(y).toMatch(/^ {4}env_file:\n {6}- path: \$\{REMATH_ENV_FILE:\?[^\n]*\n {8}format: raw$/m);
  });
  it('fixes the image tag, restart policy, user and the backup volume', () => {
    expect(y).toMatch(/^ {4}image: \$\{REMATH_IMAGE:-remath:latest\}$/m);
    expect(y).toMatch(/^ {4}restart: unless-stopped$/m);
    expect(y).toMatch(/^ {4}user: node$/m);
    expect(y).toMatch(/^ {6}- "\$\{REMATH_BACKUP_DIR:-\.\.\/backup\}:\/app\/server\/backup"$/m);
  });
});

describe('scripts/restore.sh <file> (H-31, #49)', () => {
  const RESTORE = join(ROOT, 'scripts/restore.sh');
  const TOKEN = 'sbp_token_must_not_leak';
  const MGMT = { SUPABASE_ACCESS_TOKEN: TOKEN, SUPABASE_ORG_ID: 'my-org', SUPABASE_REGION: 'ap-northeast-2', SUPABASE_DB_PASSWORD: 'db-pass' };
  const REF = 'abcdefghijklmnopqrst';
  const NEW_ENV = `SUPABASE_URL=https://${REF}.supabase.co\\nSUPABASE_SERVICE_KEY=s\\nSUPABASE_DB_URL=postgresql://postgres.${REF}:x@pooler:5432/postgres?sslmode=require\\nSUPABASE_ANON_KEY=a\\n`;
  // 백업 파일은 상대 경로로 준다(작업 디렉터리 = 가짜 배포 디렉터리): 절대 경로로 바꿔 넘겨야 한다. ADMIN_INITIAL_PASSWORD 는 없다.
  const restore = (args: string[] = ['remath-20261028.sqlite'], extra: Record<string, string> = {}) => {
    const r = deploy(args, { SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_DB_URL: '', SUPABASE_ANON_KEY: '', ADMIN_INITIAL_PASSWORD: '', NEW_ENV, ...MGMT, ...extra }, RESTORE);
    return { ...r, file: join(r.dir, 'remath-20261028.sqlite') };
  };
  it('is committed executable', () => {
    expect(execFileSync('git', ['ls-files', '-s', 'scripts/restore.sh'], { cwd: ROOT, encoding: 'utf8' })).toMatch(/^100755 /);
  });

  it('preflight + file check → new project → migrate → load (no seed) → smoke with the backup counts → env:swap → compose up → backup', () => {
    const r = restore();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const env = `REMATH_ENV_FILE=${join(r.dir, 'server.env')}`;
    expect(r.steps).toEqual([
      'docker compose -f deploy/compose.yaml config -q',
      `npm run --silent db:restore -w server -- --check ${r.file} ${env}`,
      `npm run --silent db:new-project -w server -- ${r.tmp} ${env}`,
      `npm run --silent db:migrate -w server ${env}`,
      `npm run --silent db:restore -w server -- --load ${r.file} ${env}`,
      `npm run --silent db:smoke -w server -- --restore ${r.file} ${env}`,
      `npm run --silent env:swap -w server ${env}`,
      'docker compose -f deploy/compose.yaml up -d --force-recreate',
      'docker compose -f deploy/compose.yaml exec -T server npm run --silent backup',
    ]);
    expect(r.stdout).toContain(`== 3/6 restore ${r.file}`);
    expect(r.childEnv).not.toContain(TOKEN);
    expect(r.newEnv.split('\n').filter(l => l.includes(TOKEN))).toEqual([`SUPABASE_ACCESS_TOKEN=${TOKEN}`]);
    expect(existsSync(r.tmp)).toBe(false);
  });

  it('a missing file, an unreadable backup or a missing Management var never creates a project', () => {
    const missing = restore(['nope.sqlite']);
    const bad = restore(undefined, { FAIL: '--check' });
    const token = restore(undefined, { SUPABASE_ACCESS_TOKEN: '' });
    expect([missing.status, bad.status, token.status]).toEqual([1, 1, 1]);
    expect(missing.stderr).toMatch(/backup file nope\.sqlite is not a file/);
    expect(token.stderr).toMatch(/SUPABASE_ACCESS_TOKEN is not set/);
    for (const r of [missing, bad, token]) expect(r.calls.some(c => c.includes('db:new-project'))).toBe(false);
  });

  it('takes exactly one file argument and no other option', () => {
    for (const args of [[], ['a.sqlite', 'b.sqlite'], ['--with-samples'], ['--new']]) {
      const r = restore(args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toMatch(/usage: scripts\/restore\.sh <backup\/remath-YYYYMMDD\.sqlite>/);
      expect(r.calls).toEqual([]);
    }
  });

  for (const step of ['--load', 'db:smoke']) {
    it(`a failed ${step} keeps the env file and the container and prints the new ref`, () => {
      const r = restore(undefined, { FAIL: step });
      expect(r.status).toBe(1);
      expect(r.steps.at(-1)).toMatch(step);
      expect(r.calls.some(c => c.includes('env:swap') || c.includes(' up '))).toBe(false);
      expect(readFileSync(join(r.dir, 'server.env'), 'utf8')).toBe('MOCK_LLM=1\n');
      expect(r.stderr).toMatch(new RegExp(`new Supabase project ${REF} is left in place.*delete it by hand`));
    });
  }

  it('ADMIN_INITIAL_PASSWORD set in the shell does not reach the load', () => {
    const r = restore(undefined, { ADMIN_INITIAL_PASSWORD: 'admin1234' });
    expect(r.status).toBe(0);
    expect(r.calls.some(c => c.startsWith('ADMIN_INITIAL_PASSWORD reached'))).toBe(false);
  });

  it('deploy.sh rejects --restore combined with --with-samples', () => {
    const r = deploy(['--restore', 'x.sqlite', '--with-samples'], { ...MGMT });
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
  });
});
