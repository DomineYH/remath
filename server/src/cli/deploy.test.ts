// scripts/deploy.sh 의 순서·멈춤과 deploy/compose.yaml 의 설정을 고정한다. npm·docker·curl·psql 은 가짜; 실 psql·Docker 는 수동(T-4).
// env 파일 교체 자체는 env-swap.test.ts 가 본다.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/deploy.sh');

// 가짜 도구는 받은 인자를 $LOG 에 남긴다. FAIL = 실패시킬 호출의 일부 문자열(예: db:smoke, "compose -f deploy/compose.yaml up").
const STUBS: Record<string, string> = {
  node: 'exit 0', psql: 'exit 0',
  npm: 'echo "npm $* REMATH_ENV_FILE=$REMATH_ENV_FILE" >> "$LOG"; case "$*" in *"$FAIL"*) [ -n "$FAIL" ] && exit 1 ;; esac; exit 0',
  docker: 'echo "docker $*" >> "$LOG"; case "$*" in *"$FAIL"*) [ -n "$FAIL" ] && exit 1 ;; esac; exit 0',
  curl: 'for a; do url="$a"; done; echo "curl $url" >> "$LOG"; case "$url" in */healthz) printf 200 ;; */api/auth/me) printf "${ME_CODE:-401}" ;; esac',
};
const NEW = { SUPABASE_URL: 'https://new.supabase.co', SUPABASE_SERVICE_KEY: 'new-service', SUPABASE_DB_URL: 'postgres://u:p@new:5432/postgres', SUPABASE_ANON_KEY: 'new-anon' };

function deploy(args: string[] = [], extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-test-')), bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); }
  writeFileSync(join(dir, 'server.env'), 'MOCK_LLM=1\n', { mode: 0o600 });
  const log = join(dir, 'log');
  writeFileSync(log, '');
  // REMATH_ENV_FILE 는 상대 경로로 준다: deploy.sh 가 절대 경로로 바꿔 넘겨야 한다.
  const r = spawnSync('bash', [SCRIPT, ...args], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, LOG: log, REMATH_ENV_FILE: 'server.env', ADMIN_INITIAL_PASSWORD: 'admin1234', ...NEW, ...extra },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  return { ...r, dir, calls, steps: calls.filter(c => !/^docker (info|compose version)|^curl/.test(c)) };
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

  it('an invalid compose config, --new or a missing REMATH_ENV_FILE stop before any DB step', () => {
    const c = deploy([], { FAIL: 'config -q' });
    const n = deploy(['--new']);
    const m = deploy([], { REMATH_ENV_FILE: 'missing.env' });
    expect([c.status, n.status, m.status]).toEqual([1, 2, 1]);
    expect(n.stderr).toMatch(/not supported until #48/);
    expect(m.stderr).toMatch(/REMATH_ENV_FILE missing\.env is not a file/);
    for (const r of [c, n, m]) expect(r.calls.some(x => x.startsWith('npm'))).toBe(false);
  });
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
