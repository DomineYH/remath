// scripts/deploy.sh 의 순서와 5단계 전환(H-29 5)을 가짜 npm·docker·curl·psql 로 고정한다. 실 psql·Docker 는 수동(T-4).
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/deploy.sh');

// 가짜 도구는 받은 인자를 $LOG 에 한 줄씩 남긴다. docker run 은 --env-file 내용을 "컨테이너 env"로 보관한다(STALE=1 이면 보관하지 않음).
const STUBS: Record<string, string> = {
  node: 'exit 0', psql: 'exit 0',
  npm: 'echo "npm $*" >> "$LOG"; case "$*" in *"$FAIL_STEP"*) [ -n "$FAIL_STEP" ] && exit 1 ;; esac; exit 0',
  curl: 'for a; do url="$a"; done; case "$url" in */healthz) printf 200 ;; */api/auth/me) printf "${ME_CODE:-401}" ;; esac',
  docker: `echo "docker $*" >> "$LOG"
case "$1 $2" in
  "inspect -f") case "$3" in *Image*) echo remath:old ;; *) cat "$STATE/container.env" ;; esac ;;
  run*) [ -n "$STALE" ] && exit 0; while [ $# -gt 0 ]; do [ "$1" = --env-file ] && cp "$2" "$STATE/container.env"; shift; done ;;
esac
exit 0`,
};
const OLD = 'MOCK_LLM=1\nSUPABASE_URL=https://old.supabase.co\nSUPABASE_SERVICE_KEY=old-service\nPORT=3000\nSUPABASE_ANON_KEY=old-anon\n';
const NEW = { SUPABASE_URL: 'https://new.supabase.co', SUPABASE_SERVICE_KEY: 'new-service', SUPABASE_DB_URL: 'postgres://u:p@new:5432/postgres', SUPABASE_ANON_KEY: 'new-anon' };

function deploy(args: string[] = [], extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-test-')), bin = join(dir, 'bin');
  execFileSync('mkdir', [bin]);
  for (const [name, body] of Object.entries(STUBS)) { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); }
  const envFile = join(dir, 'server.env'), log = join(dir, 'log');
  writeFileSync(envFile, OLD, { mode: 0o600 });
  writeFileSync(join(dir, 'container.env'), OLD);
  writeFileSync(log, '');
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, LOG: log, STATE: dir, REMATH_ENV_FILE: envFile, ADMIN_INITIAL_PASSWORD: 'admin1234', ...NEW, ...extra },
  });
  return { ...r, envFile, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

describe('scripts/deploy.sh', () => {
  it('is committed executable', () => {
    expect(execFileSync('git', ['ls-files', '-s', 'scripts/deploy.sh'], { cwd: ROOT, encoding: 'utf8' })).toMatch(/^100755 /);
  });

  it('migrate → seed → smoke, then swaps the four SUPABASE_* lines and recreates the container from the same image', () => {
    const r = deploy(['--with-samples']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.calls.filter(c => !c.startsWith('docker info') && !c.startsWith('docker container inspect') && !c.startsWith('docker inspect'))).toEqual([
      'npm run --silent db:migrate -w server',
      'npm run --silent db:seed -w server -- --with-samples',
      'npm run --silent db:smoke -w server -- --with-samples',
      'docker rm -f remath',
      `docker run -d --name remath --restart unless-stopped --env-file ${r.envFile} -p 3000:3000 remath:old`,
    ]);
    // 다른 줄은 그대로, SUPABASE_* 4개만 새 값, 권한 600, 이전 판은 .prev
    expect(readFileSync(r.envFile, 'utf8')).toBe('MOCK_LLM=1\nPORT=3000\n' + Object.entries(NEW).map(([k, v]) => `${k}=${v}\n`).join(''));
    expect(statSync(r.envFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(r.envFile + '.prev', 'utf8')).toBe(OLD);
  });

  it('a failed smoke leaves the env file and the container alone', () => {
    const r = deploy([], { FAIL_STEP: 'db:smoke' });
    expect(r.status).not.toBe(0);
    expect(readFileSync(r.envFile, 'utf8')).toBe(OLD);
    expect(existsSync(r.envFile + '.prev')).toBe(false);
    expect(r.calls.some(c => /^docker (rm|run|restart)/.test(c))).toBe(false);
  });

  it('fails when the recreated container does not carry the new SUPABASE_URL', () => {
    const r = deploy([], { STALE: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not run with the new SUPABASE_URL; roll back by hand: mv .*server\.env\.prev/);
  });

  it('fails when the server cannot query the new DB (/api/auth/me with an unknown cookie is not 401)', () => {
    const r = deploy([], { ME_CODE: '500' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/answered 500, want 401/);
  });

  it('--new is refused until #48; a missing REMATH_ENV_FILE stops before any DB step', () => {
    const n = deploy(['--new']);
    expect([n.status, n.calls]).toEqual([2, []]);
    expect(n.stderr).toMatch(/not supported until #48/);
    const m = deploy([], { REMATH_ENV_FILE: '' });
    expect(m.status).toBe(1);
    expect(m.calls.some(c => c.startsWith('npm'))).toBe(false);
  });
});
