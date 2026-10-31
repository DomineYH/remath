// scripts/deploy.sh·restore.sh 의 순서·멈춤·비밀 취급을 고정한다(V10, #78). npm·psql·node·git·vercel·curl·sleep 은 가짜:
// 실제 배포·네트워크·Vercel 호출은 없다. 스크립트는 임시 "저장소"(scripts/ 사본 + .vercel/project.json)에서 돈다.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ORG = 'team_fakeorg', PROJECT = 'prj_fakeproject', SHA = '0123456789abcdef0123456789abcdef01234567';
const URL_ = 'https://remath-abc123-domines-projects.vercel.app';
const CRON = 'cron-secret-must-not-leak';
const VERCEL_ERR = 'Inspect: https://vercel.com/x\n';   // vercel deploy 의 진행 표시(stderr)
const B64 = Buffer.alloc(32, 7).toString('base64'), HEX = Buffer.alloc(32, 9).toString('hex'), SHORT = Buffer.alloc(16, 7).toString('base64');
const ENV_FILE = `MOCK_LLM=1\nCRON_SECRET=${CRON}\n`;

// 가짜 도구는 받은 인자를 $LOG 에 남긴다. FAIL = 실패시킬 호출의 일부 문자열(예: db:smoke, "vercel deploy").
const failOn = 'case "$*" in *"$FAIL"*) [ -n "$FAIL" ] && exit 1 ;; esac';
const STUBS: Record<string, string> = {
  node: `exec '${process.execPath}' "$@"`, psql: 'exit 0', sleep: 'exit 0',   // node = 진짜(deploy.sh 가 배포 JSON 을 읽는다)
  // db:new-project 는 마지막 인자(deploy.sh 의 임시 env 파일)에 NEW_ENV 를 쓰고 경로를 $LOG.tmp, env 를 $LOG.newenv 에 남긴다. 나머지 호출의 env 는 $LOG.env 로.
  npm: 'echo "npm $*" >> "$LOG"; case "$*" in *db:restore*) [ -n "${ADMIN_INITIAL_PASSWORD:-}" ] && echo "ADMIN_INITIAL_PASSWORD reached $*" >> "$LOG" ;; esac; case "$*" in *db:new-project*) for a; do out="$a"; done; echo "$out" > "$LOG.tmp"; env >> "$LOG.newenv";'
    + ` [ "$FAIL" = db:new-project ] && exit 1; printf "$NEW_ENV" > "$out"; exit 0 ;; esac; env >> "$LOG.env"; ${failOn}; exit 0`,
  // archive = $SRC 를 tar 로(실제 git archive 처럼 .git 없음). status --porcelain = $GIT_STATUS.
  git: `echo "git $*" >> "$LOG"; ${failOn}; case "$1" in status) printf "$GIT_STATUS" ;; rev-parse) echo ${SHA} ;; archive) tar -cf - -C "$SRC" . ;; esac; exit 0`,
  // env add 의 값은 stdin 으로만 온다: $LOG.stdin 에 NAME=값. deploy 는 작업 디렉터리·ID 를 $LOG.copy 에 남기고 URL 을 stdout 에.
  vercel: 'echo "vercel $*" >> "$LOG"; env >> "$LOG.env"; [ "$1" = deploy ] && { echo "dir=$PWD"; echo "org=$VERCEL_ORG_ID project=$VERCEL_PROJECT_ID"; ls -A; } > "$LOG.copy";'
    + ` ${failOn}; case "$1 $2" in "env add") v=$(cat); echo "$3=$v" >> "$LOG.stdin" ;;`
    + ` deploy*) printf '${VERCEL_ERR.replace('\n', '\\n')}' >&2; if [ -n "$DEPLOY_PLAIN" ]; then echo "${URL_}"; else cat "$DEPLOY_JSON"; fi ;;`
    + ' whoami) echo someone ;; esac; exit 0',
  curl: 'echo "curl $*" >> "$LOG"; out=; hdr=; prev=; for a; do case "$prev" in -o) out="$a" ;; -H) case "$a" in @*) hdr="${a#@}" ;; esac ;; esac; prev="$a"; url="$a"; done;'
    + ' case "$url" in */healthz) printf "${HEALTH_CODE:-200}" ;; */api/auth/me) printf "${ME_CODE:-401}" ;;'
    + ' */api/cron/backup) [ -n "$hdr" ] && { ls -l "$hdr" | cut -c1-10; cat "$hdr"; } >> "$LOG.hdr"; [ -n "$out" ] && printf \'{"ok":true,"pathname":"remath-20261031.sqlite","rows":{}}\' > "$out"; printf "${CRON_CODE:-200}" ;; esac',
};
const NEW = { SUPABASE_URL: 'https://new.supabase.co', SUPABASE_SERVICE_KEY: 'service-key-must-not-leak', SUPABASE_DB_URL: 'postgres://u:dbpass-must-not-leak@new:5432/postgres', SUPABASE_ANON_KEY: 'anon-key-must-not-leak' };

interface Opts { script?: 'deploy' | 'restore'; serverEnv?: string; drop?: readonly string[]; noLink?: boolean; state?: string; deployEnv?: string }
// stdout 이 TTY 가 아닐 때 vercel deploy 가 내는 JSON(CLI 65.9.0 실측 모양, #78 rev 2).
const deployJson = (readyState: string) => JSON.stringify({
  status: 'ok',
  deployment: { id: 'dpl_fake', url: URL_, productionUrl: 'https://remath.vercel.app', inspectorUrl: 'https://vercel.com/domines-projects/remath/x', readyState, target: 'production',
    deploymentApiUrl: 'https://api.vercel.com/v13/deployments/dpl_fake', buildMachine: { cores: 2, memory: 8192, machine: 'basic' }, deploymentProtection: [] },
  message: `Deployment ${URL_.slice(8)} ready.`, next: [{ command: `vercel curl ${URL_}`, when: 'x' }],
}, null, 2) + '\n';
function deploy(args: string[] = [], extra: Record<string, string> = {}, o: Opts = {}) {
  // macOS 의 tmpdir 은 symlink(/var → /private/var)다. 스크립트가 만든 절대 경로와 맞추려고 실제 경로를 쓴다.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-test-'))), bin = join(dir, 'bin'), repo = join(dir, 'repo'), src = join(dir, 'src');
  for (const d of [bin, join(repo, 'scripts'), src]) mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    if (o.drop?.includes(name)) continue;
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755);
  }
  for (const s of ['deploy.sh', 'restore.sh']) copyFileSync(join(ROOT, 'scripts', s), join(repo, 'scripts', s));
  if (!o.noLink) { mkdirSync(join(repo, '.vercel')); writeFileSync(join(repo, '.vercel/project.json'), JSON.stringify({ projectId: PROJECT, orgId: ORG, projectName: 'remath' })); }
  writeFileSync(join(src, 'vercel.json'), '{}');   // git archive HEAD 의 내용 표지
  writeFileSync(join(dir, 'server.env'), o.serverEnv ?? ENV_FILE, { mode: 0o600 });
  writeFileSync(join(dir, 'remath-20261028.sqlite'), '');
  writeFileSync(join(dir, 'deploy.json'), deployJson(o.state ?? 'READY'));
  if (o.deployEnv !== undefined) writeFileSync(join(dir, 'deploy.env'), o.deployEnv, { mode: 0o600 });   // restore.sh 의 백업 파일(가짜 npm 은 읽지 않는다)
  const log = join(dir, 'log');
  writeFileSync(log, '');
  // REMATH_ENV_FILE 는 상대 경로로 준다(작업 디렉터리 = dir).
  const r = spawnSync('bash', [join(repo, 'scripts', `${o.script ?? 'deploy'}.sh`), ...args], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, LOG: log, SRC: src, DEPLOY_JSON: join(dir, 'deploy.json'), GIT_STATUS: '', REMATH_ENV_FILE: 'server.env', ADMIN_INITIAL_PASSWORD: 'admin1234', ...NEW, ...extra },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  const read = (f: string) => existsSync(f) ? readFileSync(f, 'utf8') : '';
  const out = {
    ...r, dir, repo, calls,
    // 단계 = npm·vercel env·vercel deploy. 사전 점검(whoami·git status)·curl 은 따로 본다.
    steps: calls.filter(c => /^npm |^vercel (env|deploy)/.test(c)),
    curls: calls.filter(c => c.startsWith('curl')).map(c => c.split(' ').at(-1) ?? ''),
    childEnv: read(`${log}.env`), newEnv: read(`${log}.newenv`), tmp: read(`${log}.tmp`).trim(),
    stdin: read(`${log}.stdin`), copy: read(`${log}.copy`), hdr: read(`${log}.hdr`), deployEnv: read(join(dir, 'deploy.env')), deployEnvPrev: read(join(dir, 'deploy.env.prev')),
  };
  return out;
}
type Run = ReturnType<typeof deploy>;
const envAdds = (names: string[]) => names.map(n => `vercel env add ${n} --environment production --sensitive --force --yes`);
const DEPLOY = 'vercel deploy --prod --yes';
const touchedVercel = (r: Run) => r.calls.some(c => /^vercel (env|deploy)/.test(c));
/** 비밀 값이 인자(로그된 argv)·출력 어디에도 없다. */
function noSecrets(r: Run, secrets: string[]) {
  for (const s of secrets) {
    expect(r.calls.join('\n'), s).not.toContain(s);
    expect(r.stdout + r.stderr, s).not.toContain(s);
  }
}

describe('scripts/deploy.sh', () => {
  it('is committed executable', () => {
    expect(execFileSync('git', ['ls-files', '-s', 'scripts/deploy.sh'], { cwd: ROOT, encoding: 'utf8' })).toMatch(/^100755 /);
  });

  it('migrate → seed → smoke → Production env (stdin only) → deploy --prod from the archive copy → /healthz, the DB probe and the cron backup', () => {
    const r = deploy(['--with-samples'], {}, { serverEnv: `MOCK_LLM=0\nKEY_VAULT_SECRET=${B64}\nMAX_TURNS=30\nCRON_SECRET=${CRON}\nBACKUP_KEEP=14\nPORT=3000\n` });
    expect(r.stderr).toBe(VERCEL_ERR);
    expect(r.status).toBe(0);
    expect(r.steps).toEqual([
      'npm run --silent db:migrate -w server',
      'npm run --silent db:seed -w server -- --with-samples',
      'npm run --silent db:smoke -w server -- --with-samples',
      ...envAdds(['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY', 'MOCK_LLM', 'KEY_VAULT_SECRET', 'MAX_TURNS', 'BACKUP_KEEP', 'CRON_SECRET']),
      DEPLOY,
    ]);
    // 값은 stdin 으로만, 줄바꿈 없이 그대로. SUPABASE_DB_URL·PORT 는 Vercel 에 넣지 않는다.
    expect(r.stdin).toBe([`SUPABASE_URL=${NEW.SUPABASE_URL}`, `SUPABASE_SERVICE_KEY=${NEW.SUPABASE_SERVICE_KEY}`, `SUPABASE_ANON_KEY=${NEW.SUPABASE_ANON_KEY}`,
      'MOCK_LLM=0', `KEY_VAULT_SECRET=${B64}`, 'MAX_TURNS=30', 'BACKUP_KEEP=14', `CRON_SECRET=${CRON}`, ''].join('\n'));
    noSecrets(r, [NEW.SUPABASE_SERVICE_KEY, NEW.SUPABASE_ANON_KEY, 'dbpass-must-not-leak', B64, CRON]);
    expect(r.curls).toEqual([`${URL_}/healthz`, `${URL_}/api/auth/me`, `${URL_}/api/cron/backup`]);
    expect(r.stdout).toContain(`deploying commit ${SHA}`);
    expect(r.stdout).toContain(`deployed ${URL_}`);
    expect(r.stdout).toMatch(/new DB answers[\s\S]*== 6\/6 backup[\s\S]*remath-20261031\.sqlite[\s\S]*deploy\.sh: ok \(commit [0-9a-f]{40}, https:\/\/remath-abc123-domines-projects\.vercel\.app\)\n$/);
  });

  it('deploys from a git archive copy of HEAD (no .git) with the linked ids, and removes the copy', () => {
    const r = deploy();
    expect(r.status).toBe(0);
    const dirLine = r.copy.split('\n')[0];
    expect(dirLine).toMatch(/^dir=\//);
    const copy = dirLine.slice('dir='.length);
    expect(copy.startsWith(r.repo)).toBe(false);
    expect(r.copy).toContain(`org=${ORG} project=${PROJECT}`);
    expect(r.copy.split('\n').slice(2)).toContain('vercel.json');   // archive 의 내용
    expect(r.copy.split('\n')).not.toContain('.git');
    expect(existsSync(copy)).toBe(false);
    expect(r.calls).toContain('git archive --format=tar HEAD');
  });

  it('the cron call sends the Bearer header from a 0600 file, never in argv', () => {
    const r = deploy();
    expect(r.status).toBe(0);
    expect(r.hdr).toBe(`-rw-------\nAuthorization: Bearer ${CRON}\n`);
    expect(r.calls.filter(c => c.startsWith('curl')).join('\n')).not.toContain(CRON);
    expect(r.calls.find(c => c.endsWith('/api/cron/backup'))).toMatch(/ -H @\//);
  });

  it('a dirty tree is refused before any step', () => {
    const r = deploy([], { GIT_STATUS: ' M server/src/app.ts\n' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/git tree is not clean/);
    expect(r.steps).toEqual([]);
  });

  for (const [what, extra, o, msg] of [
    ['vercel missing', {}, { drop: ['vercel'] }, /vercel is not installed/],
    ['vercel whoami fails', { FAIL: 'whoami' }, {}, /vercel whoami failed.*vercel login/],
    ['repo not linked', {}, { noLink: true }, /\.vercel\/project\.json.*vercel link/],
    ['CRON_SECRET missing', {}, { serverEnv: 'MOCK_LLM=1\n' }, /CRON_SECRET is not set in .*server\.env/],
    ['CRON_SECRET empty', {}, { serverEnv: 'MOCK_LLM=1\nCRON_SECRET=\n' }, /CRON_SECRET is not set in/],
    ['COOKIE_SECURE=false', {}, { serverEnv: `MOCK_LLM=1\nCRON_SECRET=${CRON}\nCOOKIE_SECURE=false\n` }, /COOKIE_SECURE=false .*production is HTTPS/],
    ['an empty optional var', {}, { serverEnv: `MOCK_LLM=1\nCRON_SECRET=${CRON}\nMAX_TURNS=\n` }, /MAX_TURNS is empty in/],
    ['REMATH_ENV_FILE missing', { REMATH_ENV_FILE: 'missing.env' }, {}, /REMATH_ENV_FILE missing\.env is not a file/],
    ['REMATH_ENV_FILE unset', { REMATH_ENV_FILE: '' }, {}, /REMATH_ENV_FILE is not set/],
  ] as const) {
    it(`a failed preflight (${what}) stops before step 1 and before any vercel env or deploy call`, () => {
      const r = deploy([], extra, o);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(msg);
      expect(r.steps).toEqual([]);
      expect(touchedVercel(r)).toBe(false);
      expect(r.stdout).not.toContain('== ');
    });
  }

  it('an unknown option stops before anything', () => {
    const r = deploy(['--bogus']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown option --bogus \(usage: scripts\/deploy\.sh \[--new\] \[--with-samples\]\)/);
    expect(r.calls).toEqual([]);
  });

  for (const step of ['db:migrate', 'db:seed', 'db:smoke']) {
    it(`a failed ${step} stops before the Production env or a deploy is touched`, () => {
      const r = deploy([], { FAIL: step });
      expect(r.status).not.toBe(0);
      expect(r.steps.at(-1)).toMatch(step);
      expect(touchedVercel(r)).toBe(false);
    });
  }

  it('takes the URL from the deploy JSON; a plain URL line is the fallback', () => {
    for (const r of [deploy(), deploy([], { DEPLOY_PLAIN: '1' })]) {
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`deployed ${URL_}\n`);
      expect(r.curls[0]).toBe(`${URL_}/healthz`);
    }
  });

  it('a deployment that is not READY fails with the rollback hint and no checks', () => {
    const r = deploy([], {}, { state: 'ERROR' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/printed no ready deployment URL; check vercel ls --prod.*vercel rollback/);
    expect(r.curls).toEqual([]);
  });

  it('a plain deploy (no --new) does not write deploy.env', () => {
    const r = deploy();
    expect(r.status).toBe(0);
    expect(existsSync(join(r.dir, 'deploy.env'))).toBe(false);
    expect(r.stdout).not.toMatch(/saved to/);
  });

  it('a failed vercel env add stops before the deploy and says the running deployment is unchanged', () => {
    const r = deploy([], { FAIL: 'env add MOCK_LLM' });
    expect(r.status).toBe(1);
    expect(r.steps.at(-1)).toBe(envAdds(['MOCK_LLM'])[0]);
    expect(r.calls.some(c => c.startsWith('vercel deploy'))).toBe(false);
    expect(r.stderr).toMatch(/vercel env add MOCK_LLM failed; the running production deployment is unchanged/);
  });

  it('a failed deploy exits non-zero with the rollback hint and still removes the copy', () => {
    const r = deploy([], { FAIL: 'deploy --prod' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/vercel deploy --prod failed.*vercel rollback/);
    expect(r.curls).toEqual([]);
    const copy = r.copy.split('\n')[0].slice('dir='.length);
    expect(copy).not.toBe('');
    expect(existsSync(copy)).toBe(false);   // EXIT trap 이 지웠다
  });

  it('a failed /healthz or a server that cannot query the new DB fails with the rollback hint', () => {
    const h = deploy([], { HEALTH_CODE: '500' });
    expect(h.status).toBe(1);
    expect(h.curls.filter(u => u.endsWith('/healthz')).length).toBe(30);
    expect(h.stderr).toMatch(new RegExp(`${URL_.replace(/[.]/g, '\\.')}/healthz did not answer 200 within 60s.*vercel rollback`));
    const db = deploy([], { ME_CODE: '500' });
    expect(db.status).toBe(1);
    expect(db.stderr).toMatch(/answered 500, want 401.*vercel rollback/);
    for (const r of [h, db]) expect(r.curls.some(u => u.endsWith('/api/cron/backup'))).toBe(false);
  });

  it('a failed cron backup exits non-zero after the switch, with how to retry', () => {
    const r = deploy([], { CRON_CODE: '500' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/first backup failed \(HTTP 500\); the switch is done and production is serving/);
    expect(r.stderr).toMatch(/retry: curl .*-H @<file with Authorization: Bearer \$CRON_SECRET> .*\/api\/cron\/backup/);
    expect(r.stderr).not.toContain(CRON);
  });
});

describe('scripts/deploy.sh --new (H-29 1, O-4)', () => {
  const TOKEN = 'sbp_token_must_not_leak';
  const MGMT = { SUPABASE_ACCESS_TOKEN: TOKEN, SUPABASE_ORG_ID: 'my-org', SUPABASE_REGION: 'ap-northeast-2', SUPABASE_DB_PASSWORD: 'db-pass' };
  const REF = 'abcdefghijklmnopqrst';
  const NEW_ENV = `SUPABASE_URL=https://${REF}.supabase.co\\nSUPABASE_SERVICE_KEY=svc-new-secret\\nSUPABASE_DB_URL=postgresql://postgres.${REF}:x@pooler:5432/postgres?sslmode=require\\nSUPABASE_ANON_KEY=anon-new-secret\\n`;
  // 셸에 이전 프로젝트의 SUPABASE_* 가 없어도 된다: 새 프로젝트에서 받는다.
  const deployNew = (args: string[] = [], extra: Record<string, string> = {}, o: Opts = {}) =>
    deploy(['--new', ...args], { SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_DB_URL: '', SUPABASE_ANON_KEY: '', NEW_ENV, ...MGMT, ...extra }, o);

  it('preflight → new project → migrate → seed → smoke → Production env → deploy, on the new project, without the token', () => {
    const r = deployNew(['--with-samples']);
    expect(r.stderr).toBe(VERCEL_ERR);
    expect(r.status).toBe(0);
    expect(r.calls.slice(0, 2)).toEqual(['vercel whoami', 'git status --porcelain']);
    expect(r.steps).toEqual([
      `npm run --silent db:new-project -w server -- ${r.tmp}`,
      'npm run --silent db:migrate -w server',
      'npm run --silent db:seed -w server -- --with-samples',
      'npm run --silent db:smoke -w server -- --with-samples',
      ...envAdds(['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY', 'MOCK_LLM', 'CRON_SECRET']),
      DEPLOY,
    ]);
    expect(r.stdout).toContain('== 1/6 new Supabase project');
    expect(r.stdout).toContain(`== 5/6 switch to https://${REF}.supabase.co`);
    expect(r.stdin).toContain(`SUPABASE_URL=https://${REF}.supabase.co\nSUPABASE_SERVICE_KEY=svc-new-secret\nSUPABASE_ANON_KEY=anon-new-secret\n`);
    expect(r.childEnv).toContain(`SUPABASE_URL=https://${REF}.supabase.co\n`);
    expect(r.childEnv).not.toContain(TOKEN);   // vercel·다른 npm 단계 어디에도
    expect(r.newEnv.split('\n').filter(l => l.includes(TOKEN))).toEqual([`SUPABASE_ACCESS_TOKEN=${TOKEN}`]);   // db:new-project 에만, 한 번
    noSecrets(r, [TOKEN, 'svc-new-secret', 'anon-new-secret', 'db-pass', CRON]);
    expect(r.tmp).not.toBe('');
    expect(existsSync(r.tmp)).toBe(false);   // EXIT trap 이 지웠다
  });

  for (const [what, extra, o] of [
    ['SUPABASE_ACCESS_TOKEN', { SUPABASE_ACCESS_TOKEN: '' }, {}], ['SUPABASE_ORG_ID', { SUPABASE_ORG_ID: '' }, {}], ['SUPABASE_REGION', { SUPABASE_REGION: '' }, {}],
    ['SUPABASE_DB_PASSWORD', { SUPABASE_DB_PASSWORD: '' }, {}], ['ADMIN_INITIAL_PASSWORD', { ADMIN_INITIAL_PASSWORD: '' }, {}],
    ['REMATH_ENV_FILE', { REMATH_ENV_FILE: 'missing.env' }, {}], ['whoami', { FAIL: 'whoami' }, {}], ['git tree is not clean', { GIT_STATUS: '?? x\n' }, {}],
    ['CRON_SECRET', {}, { serverEnv: 'MOCK_LLM=1\n' }], ['vercel link', {}, { noLink: true }],
  ] as const) {
    it(`a failed preflight (${what}) never creates a project`, () => {
      const r = deployNew([], extra, o);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(new RegExp(what));
      expect(r.calls.some(c => c.startsWith('npm'))).toBe(false);
      expect(touchedVercel(r)).toBe(false);
    });
  }

  it('keeps the new project in deploy.env (600, the 4 keys) next to REMATH_ENV_FILE, sourceable, values never in argv or output', () => {
    const r = deployNew();
    expect(r.status).toBe(0);
    const f = join(r.dir, 'deploy.env');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(r.deployEnv).toBe(`SUPABASE_URL=https://${REF}.supabase.co\nSUPABASE_SERVICE_KEY=svc-new-secret\nSUPABASE_DB_URL=postgresql://postgres.${REF}:x@pooler:5432/postgres?sslmode=require\nSUPABASE_ANON_KEY=anon-new-secret\n`);
    expect(r.stdout).toContain(`saved to ${f} (600)`);
    expect(r.stdout.indexOf('saved to')).toBeLessThan(r.stdout.indexOf('== 2/6'));   // 1단계 직후
    noSecrets(r, ['svc-new-secret', 'anon-new-secret', 'x@pooler']);
    // set -a; . <file>; set +a 로 같은 값이 돌아온다
    const back = execFileSync('bash', ['-c', `set -a; . '${f}'; set +a; printf '%s|%s' "$SUPABASE_DB_URL" "$SUPABASE_SERVICE_KEY"`], { encoding: 'utf8', env: {} });
    expect(back).toBe(`postgresql://postgres.${REF}:x@pooler:5432/postgres?sslmode=require|svc-new-secret`);
    expect(readdirSync(r.dir).filter(n => n.startsWith('deploy.env.tmp'))).toEqual([]);
  });

  it('an existing deploy.env is kept as deploy.env.prev (600); DEPLOY_ENV_FILE overrides the path', () => {
    const r = deployNew([], {}, { deployEnv: 'SUPABASE_URL=https://old.supabase.co\n' });
    expect(r.status).toBe(0);
    expect(r.deployEnvPrev).toBe('SUPABASE_URL=https://old.supabase.co\n');
    expect(statSync(join(r.dir, 'deploy.env.prev')).mode & 0o777).toBe(0o600);
    expect(r.deployEnv).toContain(`SUPABASE_URL=https://${REF}.supabase.co\n`);
    const o = deployNew([], { DEPLOY_ENV_FILE: 'other.env' });
    expect(o.status).toBe(0);
    expect(existsSync(join(o.dir, 'deploy.env'))).toBe(false);
    expect(readFileSync(join(o.dir, 'other.env'), 'utf8')).toContain('SUPABASE_ANON_KEY=anon-new-secret\n');
  });

  it('a value with shell characters is quoted so sourcing gives it back', () => {
    const odd = `SUPABASE_URL=https://${REF}.supabase.co\\nSUPABASE_SERVICE_KEY=a b$c'd\\nSUPABASE_DB_URL=postgresql://p:x@h:5432/postgres?a=1&b=2\\nSUPABASE_ANON_KEY=a\\n`;
    const r = deployNew([], { NEW_ENV: odd });
    expect(r.status).toBe(0);
    const back = execFileSync('bash', ['-c', `set -a; . '${join(r.dir, 'deploy.env')}'; set +a; printf '%s|%s' "$SUPABASE_SERVICE_KEY" "$SUPABASE_DB_URL"`], { encoding: 'utf8', env: {} });
    expect(back).toBe("a b$c'd|postgresql://p:x@h:5432/postgres?a=1&b=2");
  });

  it('a failed vercel env add after --new points to loading deploy.env', () => {
    const r = deployNew([], { FAIL: 'env add SUPABASE_ANON_KEY' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`set -a; . ${join(r.dir, 'deploy.env')}; set +a and run scripts/deploy.sh again without --new`);
  });

  it('a failed new-project stops there; the temp env file is removed', () => {
    const r = deployNew([], { FAIL: 'db:new-project' });
    expect(r.status).toBe(1);
    expect(r.steps.at(-1)).toMatch(/db:new-project/);
    expect(existsSync(r.tmp)).toBe(false);
  });

  it('a failed smoke leaves Vercel alone and prints the new ref to delete by hand (H-29 4)', () => {
    const r = deployNew([], { FAIL: 'db:smoke' });
    expect(r.status).toBe(1);
    expect(r.steps.at(-1)).toMatch(/db:smoke/);
    expect(touchedVercel(r)).toBe(false);
    expect(r.stderr).toMatch(new RegExp(`new Supabase project ${REF} is left in place.*delete it by hand`));
    expect(existsSync(r.tmp)).toBe(false);
  });

  it('once the Production env is touched a failure does not tell the operator to delete the project', () => {
    for (const extra of [{ FAIL: 'env add SUPABASE_ANON_KEY' }, { FAIL: 'deploy --prod' }, { CRON_CODE: '500' }] as Record<string, string>[]) {
      const r = deployNew([], extra);
      expect(r.status).toBe(1);
      expect(r.stderr).not.toMatch(/delete it by hand/);
      expect(r.stderr).toContain(REF);
    }
  });

  it('still rejects unknown options and stops before anything', () => {
    const r = deployNew(['--bogus']);
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
  });
});

// Q25: 런타임 env 파일이 MOCK_LLM=0 이면 KEY_VAULT_SECRET 이 32바이트여야 서버가 뜬다(vault.ts parseSecret) — 1단계 전에 멈춘다.
describe('scripts/deploy.sh KEY_VAULT_SECRET preflight (Q25)', () => {
  const MGMT = { SUPABASE_ACCESS_TOKEN: 't', SUPABASE_ORG_ID: 'o', SUPABASE_REGION: 'r', SUPABASE_DB_PASSWORD: 'p', NEW_ENV: '' };
  const live = (secret?: string) => `CRON_SECRET=${CRON}\nMOCK_LLM=0\n${secret === undefined ? '' : `KEY_VAULT_SECRET=${secret}\n`}`;
  const all = (body: string) => [deploy([], {}, { serverEnv: body }), deploy(['--new'], MGMT, { serverEnv: body }), deploy(['remath-20261028.sqlite'], MGMT, { script: 'restore', serverEnv: body })];

  for (const [what, body, msg] of [
    ['missing', live(), /KEY_VAULT_SECRET is not set/], ['empty', live(''), /KEY_VAULT_SECRET is not set/],
    ['16 bytes', live(SHORT), /KEY_VAULT_SECRET in .* is not 32 bytes \(base64 or 64 hex chars\)/], ['63 hex chars', live(HEX.slice(1)), /KEY_VAULT_SECRET in .* is not 32 bytes \(base64 or 64 hex chars\)/],
    ['not base64', live('!'.repeat(44)), /KEY_VAULT_SECRET in .* is not 32 bytes \(base64 or 64 hex chars\)/],
    // 서버는 끝만 trim 한다: 가운데 공백이 있으면 hex 가 아니라 base64 48바이트로 읽혀 뜨지 못한다.
    ['32 hex + space + 32 hex', live(`${HEX.slice(0, 32)} ${HEX.slice(32)}`), /KEY_VAULT_SECRET in .* is not 32 bytes \(base64 or 64 hex chars\)/],
  ] as const) {
    it(`MOCK_LLM=0 with a ${what} secret stops before anything, with how to make one`, () => {
      for (const r of all(body)) {
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(msg);
        expect(r.stderr).toMatch(/openssl rand -base64 32/);
        expect(r.steps).toEqual([]);   // db:restore --check·db:new-project·vercel 전
        expect(touchedVercel(r)).toBe(false);
        if (body.includes('KEY_VAULT_SECRET=') && body !== live('')) expect(r.stderr).not.toContain(body.split('KEY_VAULT_SECRET=')[1].trim());
      }
    });
  }

  // 서버(config.ts)는 MOCK_LLM 이 정확히 '0'·'1' 이어야 뜬다. 사전 점검도 줄 끝 CR 하나만 떼고 같은 규칙.
  for (const [what, body] of [['padded', `MOCK_LLM= 0\nKEY_VAULT_SECRET=${B64}\n`], ['trailing space', 'MOCK_LLM=1 \n'], ['not 0/1', 'MOCK_LLM=true\n'], ['missing', `CRON_SECRET=${CRON}\n`]] as const) {
    it(`MOCK_LLM ${what} stops before anything`, () => {
      for (const r of all(body)) {
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/MOCK_LLM in .* must be exactly 0 or 1/);
        expect(r.steps).toEqual([]);
      }
    });
  }

  for (const [what, body, sent] of [
    ['base64', live(B64), B64], ['hex', live(HEX), HEX], ['base64 with CRLF', live(`${B64}\r`), B64], ['MOCK_LLM=1 without a secret', `MOCK_LLM=1\nCRON_SECRET=${CRON}\n`, null],
    ['MOCK_LLM=1 with CRLF', `MOCK_LLM=1\r\nCRON_SECRET=${CRON}\r\n`, null], ['MOCK_LLM=0 with CRLF', `MOCK_LLM=0\r\nKEY_VAULT_SECRET=${B64}\r\nCRON_SECRET=${CRON}\r\n`, B64],
    ['base64 with spaces around', live(`  ${B64} \t`), `  ${B64} \t`], ['hex with spaces around', live(` ${HEX}  \r`), ` ${HEX}  `],
  ] as const) {
    it(`passes with ${what}; values reach Vercel without the CR`, () => {
      const r = deploy([], {}, { serverEnv: body });
      expect(r.stderr).toBe(VERCEL_ERR);
      expect(r.status).toBe(0);
      expect(r.stdin).toContain(`MOCK_LLM=${body.includes('MOCK_LLM=0') ? 0 : 1}\n`);
      expect(r.stdin).toContain(`CRON_SECRET=${CRON}\n`);
      if (sent) expect(r.stdin).toContain(`KEY_VAULT_SECRET=${sent}\n`);
      expect(r.stdin).not.toContain('\r');
    });
  }
});

describe('scripts/restore.sh <file> (H-31, #49)', () => {
  const TOKEN = 'sbp_token_must_not_leak';
  const MGMT = { SUPABASE_ACCESS_TOKEN: TOKEN, SUPABASE_ORG_ID: 'my-org', SUPABASE_REGION: 'ap-northeast-2', SUPABASE_DB_PASSWORD: 'db-pass' };
  const REF = 'abcdefghijklmnopqrst';
  const NEW_ENV = `SUPABASE_URL=https://${REF}.supabase.co\\nSUPABASE_SERVICE_KEY=s\\nSUPABASE_DB_URL=postgresql://postgres.${REF}:x@pooler:5432/postgres?sslmode=require\\nSUPABASE_ANON_KEY=a\\n`;
  // 백업 파일은 상대 경로로 준다(작업 디렉터리 = 가짜 배포 디렉터리): 절대 경로로 바꿔 넘겨야 한다. ADMIN_INITIAL_PASSWORD 는 없다.
  const restore = (args: string[] = ['remath-20261028.sqlite'], extra: Record<string, string> = {}) => {
    const r = deploy(args, { SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_DB_URL: '', SUPABASE_ANON_KEY: '', ADMIN_INITIAL_PASSWORD: '', NEW_ENV, ...MGMT, ...extra }, { script: 'restore' });
    return { ...r, file: join(r.dir, 'remath-20261028.sqlite') };
  };
  it('is committed executable', () => {
    expect(execFileSync('git', ['ls-files', '-s', 'scripts/restore.sh'], { cwd: ROOT, encoding: 'utf8' })).toMatch(/^100755 /);
  });

  it('preflight + file check → new project → migrate → load (no seed) → smoke with the backup counts → Production env → deploy → backup', () => {
    const r = restore();
    expect(r.stderr).toBe(VERCEL_ERR);
    expect(r.status).toBe(0);
    expect(r.steps).toEqual([
      `npm run --silent db:restore -w server -- --check ${r.file}`,
      `npm run --silent db:new-project -w server -- ${r.tmp}`,
      'npm run --silent db:migrate -w server',
      `npm run --silent db:restore -w server -- --load ${r.file}`,
      `npm run --silent db:smoke -w server -- --restore ${r.file}`,
      ...envAdds(['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY', 'MOCK_LLM', 'CRON_SECRET']),
      DEPLOY,
    ]);
    expect(r.curls).toEqual([`${URL_}/healthz`, `${URL_}/api/auth/me`, `${URL_}/api/cron/backup`]);
    expect(r.stdout).toContain(`== 3/6 restore ${r.file}`);
    expect(r.deployEnv).toContain(`SUPABASE_URL=https://${REF}.supabase.co\n`);   // 복구도 새 프로젝트를 남긴다
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
    for (const r of [missing, bad, token]) {
      expect(r.calls.some(c => c.includes('db:new-project'))).toBe(false);
      expect(touchedVercel(r)).toBe(false);
    }
  });

  it('takes exactly one file argument and no other option', () => {
    for (const args of [[], ['a.sqlite', 'b.sqlite'], ['--with-samples'], ['--new']]) {
      const r = restore(args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toMatch(/usage: scripts\/restore\.sh <remath-YYYYMMDD\.sqlite>/);
      expect(r.calls).toEqual([]);
    }
  });

  for (const step of ['--load', 'db:smoke']) {
    it(`a failed ${step} leaves Vercel alone and prints the new ref`, () => {
      const r = restore(undefined, { FAIL: step });
      expect(r.status).toBe(1);
      expect(r.steps.at(-1)).toMatch(step);
      expect(touchedVercel(r)).toBe(false);
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

// 지운 Docker 경로가 돌아오지 않게(V14).
describe('one deploy path (V14)', () => {
  it('no Dockerfile, compose file or env:swap remain', () => {
    for (const f of ['Dockerfile', '.dockerignore', 'deploy/compose.yaml', 'server/src/cli/env-swap.ts']) expect(existsSync(join(ROOT, f)), f).toBe(false);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'server/package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['env:swap']).toBeUndefined();
  });
});
