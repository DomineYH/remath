#!/usr/bin/env bash
# 배포 (#35 H-29, D-15~17, V10 #78). 운영자 머신에서 돈다. --new 면 1) Management API 로 새 Supabase 프로젝트(O-4, npm run db:new-project),
#   없으면 셸의 SUPABASE_* 4개 프로젝트에 2) 미적용 마이그레이션 → 3) 시드 → 4) 스모크
#   → 5) 전환: Vercel Production env 설정(SUPABASE_URL·SERVICE_KEY + 런타임 env 파일의 변수, 값은 stdin 으로만)
#      → HEAD 의 git archive 사본에서 vercel deploy --prod → 그 배포 URL 의 /healthz 200 + 새 DB 응답(401) 확인
#   → 6) 첫 백업: 그 URL 의 GET /api/cron/backup(CRON_SECRET Bearer, 0600 헤더 파일로) → 200 + { ok: true, pathname }.
#      끝으로 production 도메인(REMATH_PROD_URL, 기본 https://remath-eight.vercel.app)의 /healthz 를 읽기만 한다(200 아니면 경고).
#      위 확인은 새 배포 URL 이 도는 것까지다: 롤백 뒤에는 도메인이 vercel promote <url> 전까지 이전 배포에 남는다.
# 어느 단계든 실패하면 거기서 멈추고 종료코드 ≠ 0. 4단계까지 실패하면 Vercel 은 건드리지 않는다.
# env 값은 배포를 만들 때 고정된다: 실행 중인 production 은 새 배포가 올라갈 때까지 이전 DB 를 쓴다.
# 되돌리기 = vercel rollback <대상> --yes: 사전 점검이 vercel alias ls 로 지금 production 도메인 뒤의 배포를 찾아 안내에 넣는다.
# 두 번째 실행은 DB 를 바꾸지 않는다(같은 env 로 새 production 배포가 하나 더 생긴다).
#
#   set -a; . ~/.config/remath/deploy.env; set +a      # SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_DB_URL SUPABASE_ANON_KEY (--new 가 썼다)
#   read -rs ADMIN_INITIAL_PASSWORD && export ADMIN_INITIAL_PASSWORD
#   REMATH_ENV_FILE=~/.config/remath/prod.env scripts/deploy.sh [--with-samples]
#
# 새 프로젝트(--new): 셸에 SUPABASE_ACCESS_TOKEN SUPABASE_ORG_ID(조직 slug) SUPABASE_REGION SUPABASE_DB_PASSWORD ADMIN_INITIAL_PASSWORD.
#   SUPABASE_* 4개는 새 프로젝트에서 받아 임시 env 파일(mktemp, 600, 종료 시 삭제)로 2~5단계에 넘긴다(SUPABASE_DB_URL·SUPABASE_ANON_KEY 는 Vercel 에 넣지 않는다: 서버 런타임이 읽지 않는다).
#   1단계 직후 그 4개를 DEPLOY_ENV_FILE(기본 = REMATH_ENV_FILE 옆 deploy.env, 600, 이전 판 .prev)에 남긴다: 재배포는 set -a; . <그 파일>; set +a.
#   REMATH_ENV_FILE=~/.config/remath/prod.env scripts/deploy.sh --new [--with-samples]
#   사전 점검이 모두 통과해야 프로젝트를 만든다(과금). 토큰은 db:new-project 에만 넘어가고 vercel·다른 단계·파일에는 없다.
#   Vercel env 를 건드리기 전에 실패하면 새 프로젝트는 남겨 두고 ref 를 알린다(사람이 삭제). 어떤 경로도 프로젝트를 지우거나 바꾸지 않는다.
#   NEW_PROJECT_TIMEOUT_S(기본 600): ACTIVE_HEALTHY 대기 한도. DEPLOY_NEW_FAULT=anon_as_service: G3 8단계 실패 경로(스모크가 FAIL 해야 한다).
#
# 복구(--restore <file>, scripts/restore.sh 가 부른다, H-31): --new 와 같고 3단계 시드 대신 백업 파일 적재(db:restore --load),
#   4단계 스모크의 기대 행 수 = 백업 파일의 행 수. 파일 점검(db:restore --check)도 사전 점검이라 프로젝트 생성 전. ADMIN_INITIAL_PASSWORD 는 쓰지 않는다.
#
# REMATH_ENV_FILE(필수): production 런타임 env 파일(저장소 밖, 600). 스크립트는 읽기만 한다. 한 줄 KEY=value(첫 = 뒤 글자 그대로).
#   MOCK_LLM(0|1)·CRON_SECRET(필수, Vercel Production 의 값과 같게), MOCK_LLM=0 이면 KEY_VAULT_SECRET(32바이트, openssl rand -base64 32),
#   선택 MAX_TURNS·TURN_TIMEOUT_MS·BACKUP_KEEP(양의 정수). 있는 것만 Vercel 에 넣는다(없는 이름은 Vercel 에 있던 값 그대로). COOKIE_SECURE=false 는 거절한다.
# 사전 점검(1단계 전): 도구 node npm psql curl git vercel, vercel whoami, .vercel/project.json(vercel link), 깨끗한 git 트리(git status 실패도 멈춤), 위 env 파일 규칙.
# Hobby 는 HEAD 커밋 작성자가 Vercel 계정에 없으면 CLI 배포를 막는다: 그래서 git 메타데이터 없는 git archive 사본에서 배포한다.
set -euo pipefail

with_samples=() new= restore=
usage() { echo "deploy.sh: $1 (usage: scripts/deploy.sh [--new] [--with-samples])" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --with-samples) with_samples=(-- --with-samples) ;;
    --new) new=1 ;;
    --restore) [ -n "${2:-}" ] || usage "--restore needs a file"; restore="$2" new=1; shift ;;
    *) usage "unknown option $1" ;;
  esac
  shift
done
[ -n "$restore" ] && [ ${#with_samples[@]} -gt 0 ] && usage "--restore loads a backup; --with-samples does not apply"
# 토큰은 내보내지 않는 셸 변수로만 들고 db:new-project 한 번에만 넘긴다: vercel·다른 npm 단계의 env 에 없다.
token="${SUPABASE_ACCESS_TOKEN:-}"; unset SUPABASE_ACCESS_TOKEN

fail() { echo "deploy.sh: $*" >&2; exit 1; }
for tool in node npm psql curl git vercel; do
  command -v "$tool" >/dev/null || fail "$tool is not installed (needed on the operator machine; psql = postgresql-client, vercel = npm i -g vercel)"
done
if [ -n "$new" ]; then need=(SUPABASE_ORG_ID SUPABASE_REGION SUPABASE_DB_PASSWORD); [ -n "$token" ] || fail "SUPABASE_ACCESS_TOKEN is not set"
else need=(SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_DB_URL SUPABASE_ANON_KEY); fi
if [ -n "$restore" ]; then unset ADMIN_INITIAL_PASSWORD   # 백업의 관리자 해시가 돌아온다: 어느 단계도 읽지 않게
else need+=(ADMIN_INITIAL_PASSWORD); fi
for v in "${need[@]}" REMATH_ENV_FILE; do
  [ -n "${!v:-}" ] || fail "$v is not set"
done
[ -f "$REMATH_ENV_FILE" ] || fail "REMATH_ENV_FILE $REMATH_ENV_FILE is not a file"
REMATH_ENV_FILE="$(realpath "$REMATH_ENV_FILE")"
# --new·--restore 가 만든 프로젝트의 SUPABASE_* 4개를 남기는 파일(재배포·admin:reset-password 가 쓴다). 기본 = 런타임 env 파일 옆 deploy.env.
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$(dirname "$REMATH_ENV_FILE")/deploy.env}"
case $DEPLOY_ENV_FILE in /*) ;; *) DEPLOY_ENV_FILE="$PWD/$DEPLOY_ENV_FILE" ;; esac   # 스크립트는 곧 저장소 루트로 cd 한다
[ -z "$new" ] || [ -d "$(dirname "$DEPLOY_ENV_FILE")" ] || fail "DEPLOY_ENV_FILE $DEPLOY_ENV_FILE: its directory does not exist"
# 런타임 env 파일은 읽기만 한다: DEPLOY_ENV_FILE(또는 그 .prev)이 같은 파일이거나 symlink 로 그리 이어지면 덮어쓰게 된다 → 1단계 전에 멈춘다.
# 비교는 symlink 를 푼 절대 경로끼리(REMATH_ENV_FILE 은 위에서 realpath 했다). 없는 파일은 디렉터리만 풀고 이름을 붙인다.
resolve() { if [ -e "$1" ] || [ -L "$1" ]; then realpath "$1" 2>/dev/null || printf %s "$1"; else printf '%s/%s' "$(realpath "$(dirname "$1")" 2>/dev/null || dirname "$1")" "$(basename "$1")"; fi; }
for f in "$DEPLOY_ENV_FILE" "$DEPLOY_ENV_FILE.prev"; do
  [ "$(resolve "$f")" != "$REMATH_ENV_FILE" ] || fail "DEPLOY_ENV_FILE $DEPLOY_ENV_FILE (or its .prev $f) is the same file as REMATH_ENV_FILE $REMATH_ENV_FILE; keep them apart (set DEPLOY_ENV_FILE to another path)"
done
# 런타임 env 파일의 값: 그 키의 마지막 줄, 첫 = 뒤 글자 그대로, 줄 끝 CR 하나만 뗀다. 없으면 빈 문자열. 값은 출력하지 않는다.
env_get() { local l v=; while IFS= read -r l || [ -n "$l" ]; do case $l in "$1="*) v="${l#*=}" ;; esac; done < "$REMATH_ENV_FILE"; printf %s "${v%$'\r'}"; }
env_has() { grep -q "^$1=" "$REMATH_ENV_FILE"; }
# Q25: MOCK_LLM=0 이면 서버는 KEY_VAULT_SECRET 이 32바이트(hex 64자 또는 base64, vault.ts parseSecret)여야 뜬다.
check_vault_secret() {
  local m s n how="make one with: openssl rand -base64 32 and put it in that file"
  m="$(env_get MOCK_LLM)"   # 서버(config.ts)와 같은 규칙: 정확히 0 또는 1
  [ "$m" = 0 ] || [ "$m" = 1 ] || fail "MOCK_LLM in $REMATH_ENV_FILE must be exactly 0 or 1 (no spaces)"
  [ "$m" = 0 ] || return 0
  # 서버(vault.ts parseSecret)와 같이 앞뒤 공백만 뗀다. 가운데 글자는 그대로 둔다.
  s="$(env_get KEY_VAULT_SECRET)"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"
  [ -n "$s" ] || fail "MOCK_LLM=0 but KEY_VAULT_SECRET is not set in $REMATH_ENV_FILE; $how"
  [[ $s =~ ^[0-9a-fA-F]{64}$ ]] && return 0
  n="$(printf %s "$s" | base64 -d 2>/dev/null | wc -c)" || n=0
  [ "$n" -eq 32 ] || fail "KEY_VAULT_SECRET in $REMATH_ENV_FILE is not 32 bytes (base64 or 64 hex chars); $how"
}
check_vault_secret
[ -n "$(env_get CRON_SECRET)" ] || fail "CRON_SECRET is not set in $REMATH_ENV_FILE; use the value already in the Vercel Production env (the backup cron sends it)"
[ "$(env_get COOKIE_SECURE)" != false ] || fail "COOKIE_SECURE=false in $REMATH_ENV_FILE: production is HTTPS, remove that line"
# Vercel 에 넣는 런타임 변수(이 순서). 줄이 있는데 값이 비면 서버 검증에 걸린다: 1단계 전에 멈춘다.
RUNTIME=(MOCK_LLM KEY_VAULT_SECRET MAX_TURNS TURN_TIMEOUT_MS BACKUP_KEEP CRON_SECRET)
for v in "${RUNTIME[@]}"; do
  ! env_has "$v" || [ -n "$(env_get "$v")" ] || fail "$v is empty in $REMATH_ENV_FILE; remove the line or give it a value"
done
# 서버(config.ts·backup.ts)는 이 셋을 양의 정수로만 받는다(아니면 함수가 설정 검증에서 500). 값은 출력하지 않는다.
# z.coerce.number().int().positive(): 숫자로 바꿔 안전한 정수(Number.isSafeInteger)여야 한다. 값은 env 로 node 에 넘긴다(인자 아님).
for v in MAX_TURNS TURN_TIMEOUT_MS BACKUP_KEEP; do
  ! env_has "$v" || { [[ $(env_get "$v") =~ ^0*[1-9][0-9]*$ ]] \
    && N="$(env_get "$v")" node -e 'const n = Number(process.env.N); process.exit(Number.isSafeInteger(n) && n > 0 ? 0 : 1)'; } \
    || fail "$v in $REMATH_ENV_FILE must be a positive safe integer (digits only, at most 9007199254740991)"
done
if [ -n "$restore" ]; then
  [ -f "$restore" ] || fail "backup file $restore is not a file"
  restore="$(realpath "$restore")"   # npm -w server 는 server/ 에서 돈다
fi

cd "$(dirname "$0")/.."
vercel whoami >/dev/null 2>&1 || fail "vercel whoami failed: run vercel login first"
[ -f .vercel/project.json ] || fail ".vercel/project.json is missing: run vercel link (project remath) in the repo root first"
link="$(cat .vercel/project.json)"
[[ $link =~ \"orgId\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] || fail ".vercel/project.json has no orgId: run vercel link again"; org="${BASH_REMATCH[1]}"
[[ $link =~ \"projectId\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] || fail ".vercel/project.json has no projectId: run vercel link again"; project="${BASH_REMATCH[1]}"
# 지금 production 도메인 뒤의 배포(읽기만): 실패 시 되돌릴 대상. 없으면(첫 배포 전·별칭 없음) 안내만 바꾸고 계속한다.
PROD_URL="${REMATH_PROD_URL:-https://remath-eight.vercel.app}"; PROD_URL="${PROD_URL%/}"
prod_host="${PROD_URL#*://}"; prod_host="${prod_host%%/*}"
prev_dep="$(vercel alias ls --json --limit 100 2>/dev/null | H="$prod_host" node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    let j; try { j = JSON.parse(s); } catch { process.exit(1); }
    const a = (j && Array.isArray(j.aliases) ? j.aliases : []).find(x => x && x.alias === process.env.H);
    if (!a || !a.deploymentId) process.exit(1);
    console.log(a.url ? `https://${String(a.url).replace(/^https?:\/\//, "")} (${a.deploymentId})` : a.deploymentId);
  });')" || prev_dep=
if [ -n "$prev_dep" ]; then
  echo "deploy.sh: current production ($prod_host): $prev_dep"
  rollback_cmd="vercel rollback ${prev_dep%% *} --yes"
else
  echo "deploy.sh: note: no current production deployment found for $prod_host (vercel alias ls)"
  rollback_cmd="vercel ls remath --prod, then vercel rollback <previous READY production url> --yes"
fi
status="$(git status --porcelain)" || fail "cannot read git status (git status --porcelain failed); production is built from HEAD of a clean tree"
[ -z "$status" ] || fail "the git tree is not clean (git status --porcelain): commit or remove the changes; production is built from HEAD"
# 백업이 아니거나 테이블·열이 빠졌으면 여기서 멈춘다: 프로젝트를 만들기 전.
[ -z "$restore" ] || npm run --silent db:restore -w server -- --check "$restore" || fail "$restore is not a usable backup file"

tmp_env= copy= hdr= body= envtmp= ref= switched=
# 새 프로젝트의 SUPABASE_* 4개를 DEPLOY_ENV_FILE 에 원자적으로(umask 077 임시 파일 → mv) 쓴다. 이전 파일은 <파일>.prev(600).
# 값은 printf(셸 내장)로 파일에만: 인자·출력에 없다. set -a; . <파일>; set +a 로 읽힌다(셸에 안전한 글자가 아니면 %q 로 따옴).
save_deploy_env() {
  local k v
  envtmp="$(umask 077; mktemp "$DEPLOY_ENV_FILE.tmp.XXXXXX")" || fail "cannot write $DEPLOY_ENV_FILE"   # 실패하면 EXIT trap 이 지운다
  for k in SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_DB_URL SUPABASE_ANON_KEY; do
    v="${!k}"
    if [[ $v =~ ^[A-Za-z0-9._~:/?=%@+,-]*$ ]]; then printf '%s=%s\n' "$k" "$v"; else printf '%s=%q\n' "$k" "$v"; fi
  done > "$envtmp"
  if [ -f "$DEPLOY_ENV_FILE" ]; then
    (umask 077; cp "$DEPLOY_ENV_FILE" "$DEPLOY_ENV_FILE.prev") && chmod 600 "$DEPLOY_ENV_FILE.prev" || fail "cannot keep $DEPLOY_ENV_FILE.prev"
  fi
  mv -f "$envtmp" "$DEPLOY_ENV_FILE" || fail "cannot write $DEPLOY_ENV_FILE"
  envtmp=
  echo "deploy.sh: new project's SUPABASE_* saved to $DEPLOY_ENV_FILE (600)"
}
# 끝날 때 임시 파일·사본을 지운다. Vercel 을 건드리기 전 실패 = 새 프로젝트는 쓰이지 않는다: ref 를 알리고 남겨 둔다.
cleanup() {
  local st=$?
  rm -rf ${tmp_env:+"$tmp_env"} ${copy:+"$copy"} ${hdr:+"$hdr"} ${body:+"$body"} ${envtmp:+"$envtmp"}
  [ $st -ne 0 ] && [ -n "$ref" ] && [ -z "$switched" ] && echo "deploy.sh: new Supabase project $ref is left in place (not switched to); delete it by hand in the dashboard" >&2
  exit $st
}
trap cleanup EXIT
if [ -n "$new" ]; then
  tmp_env="$(mktemp)"
  echo "== 1/6 new Supabase project"
  SUPABASE_ACCESS_TOKEN="$token" npm run --silent db:new-project -w server -- "$tmp_env"
  unset token
  # source 하지 않는다: 값(DB 비밀번호 등)을 셸 문법으로 해석하지 않게 줄마다 첫 = 에서 나눈다.
  while IFS= read -r line; do export "${line%%=*}=${line#*=}"; done < "$tmp_env"
  ref="${SUPABASE_URL#https://}"; ref="${ref%%.*}"
  save_deploy_env
fi

echo "== 2/6 migrations"
npm run --silent db:migrate -w server
if [ -n "$restore" ]; then
  echo "== 3/6 restore $restore"
  npm run --silent db:restore -w server -- --load "$restore"
  echo "== 4/6 smoke"
  npm run --silent db:smoke -w server -- --restore "$restore"
else
  echo "== 3/6 seed"
  npm run --silent db:seed -w server ${with_samples[@]+"${with_samples[@]}"}
  echo "== 4/6 smoke"
  npm run --silent db:smoke -w server ${with_samples[@]+"${with_samples[@]}"}
fi

echo "== 5/6 switch to $SUPABASE_URL"
switched=1   # 여기부터 Vercel Production env 가 새 프로젝트를 가리킬 수 있다: 프로젝트를 지우라고 하지 않는다
where="${ref:+ (new Supabase project $ref)}"
again="fix and run scripts/deploy.sh again"
[ -z "$ref" ] || again="fix, load the new project with set -a; . $DEPLOY_ENV_FILE; set +a and run scripts/deploy.sh again without --new"
# 값은 printf(셸 내장)로 stdin 에만: 인자·로그·파일에 남지 않는다. --force = 같은 환경의 기존 값 덮어쓰기.
set_env() {
  printf %s "$2" | vercel env add "$1" --environment production --sensitive --force --yes >/dev/null \
    || fail "vercel env add $1 failed; the running production deployment is unchanged (env is fixed per deployment), but the Production env may be partly updated$where: $again"
}
set_env SUPABASE_URL "$SUPABASE_URL"
set_env SUPABASE_SERVICE_KEY "$SUPABASE_SERVICE_KEY"
for v in "${RUNTIME[@]}"; do
  ! env_has "$v" || set_env "$v" "$(env_get "$v")"
done
echo "deploy.sh: Production env set (SUPABASE_URL SUPABASE_SERVICE_KEY$(for v in "${RUNTIME[@]}"; do env_has "$v" && printf ' %s' "$v"; done))"

rollback="roll back: $rollback_cmd (that deployment serves again with its own env)$where"
sha="$(git rev-parse HEAD)"
copy="$(mktemp -d)"
git archive --format=tar HEAD | tar -xf - -C "$copy" || fail "git archive HEAD failed; nothing was deployed"
echo "deploy.sh: deploying commit $sha from a git archive copy"
# 링크 대신 ID 를 env 로: 사본에는 .vercel·.git 이 없다. 진행 표시는 stderr, 배포 URL 은 stdout.
out="$(cd "$copy" && VERCEL_ORG_ID="$org" VERCEL_PROJECT_ID="$project" vercel deploy --prod --yes)" \
  || fail "vercel deploy --prod failed; production keeps the previous deployment unless the output above shows a new one ready, then $rollback"
rm -rf "$copy"; copy=
# stdout 이 TTY 가 아니면 CLI 는 JSON({status, deployment:{url, readyState, …}})을 낸다. JSON 이 아니면 마지막 *.vercel.app URL 줄.
st=0
url="$(printf '%s' "$out" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    let j; try { j = JSON.parse(s); } catch { process.exit(3); }
    const d = j && j.deployment;
    if (j.status !== "ok" || !d || d.readyState !== "READY" || typeof d.url !== "string" || !d.url) process.exit(4);
    console.log(d.url.startsWith("https://") ? d.url : `https://${d.url}`);
  });')" || st=$?
[ $st -ne 3 ] || { st=0; url="$(printf '%s\n' "$out" | grep -E '^https://[^ ]+\.vercel\.app$' | tail -n 1)" || true; }
[ $st -eq 0 ] && [ -n "$url" ] || fail "vercel deploy --prod printed no ready deployment URL; check vercel ls --prod, and if a new one is serving, $rollback"
echo "deploy.sh: deployed $url"

code() { curl -s -o /dev/null -w '%{http_code}' "$@" || true; }   # 연결 실패 = 000
for _ in $(seq 30); do
  if [ "$(code "$url/healthz")" = 200 ]; then
    # /healthz 는 DB 를 보지 않는다. 모르는 로그인 쿠키 → 서버가 새 env 의 DB 에서 auth_sessions 를 조회해 401.
    # URL·키가 틀려 DB 를 못 읽으면 500 이다.
    got="$(code -H "Cookie: remath_teacher=deploy-check-$RANDOM" "$url/api/auth/me")"
    [ "$got" = 401 ] || fail "GET /api/auth/me with an unknown cookie answered $got, want 401 (the deployment cannot query the new DB); $rollback"
    echo "deploy.sh: the new deployment serves ($url/healthz 200, new DB answers)"
    echo "== 6/6 backup"
    # 크론과 같은 경로를 한 번 부른다. Bearer 는 0600 임시 파일의 헤더로만(curl -H @file): 인자·출력에 없다.
    hdr="$(mktemp)"; body="$(mktemp)"   # 둘 다 EXIT trap 이 지운다
    printf 'Authorization: Bearer %s\n' "$(env_get CRON_SECRET)" > "$hdr"
    got="$(curl -s --max-time 300 -H @"$hdr" -o "$body" -w '%{http_code}' "$url/api/cron/backup" || true)"
    # 성공 = 200 이고 본문이 { ok: true, pathname: "<비지 않은 문자열>" }.
    pathname="$(node -e '
      let j; try { j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(1); }
      if (!j || j.ok !== true || typeof j.pathname !== "string" || !j.pathname) process.exit(1);
      console.log(j.pathname);' "$body" 2>/dev/null)" || pathname=
    why="HTTP $got"; [ "$got" != 200 ] || why="HTTP 200 without ok/pathname in the body"
    [ "$got" = 200 ] && [ -n "$pathname" ] || fail "first backup failed ($why); the switch is done and the new deployment $url serves$where. See Vercel runtime logs (backup failed: …), then retry: curl -H @<file with Authorization: Bearer \$CRON_SECRET> $url/api/cron/backup"
    echo "deploy.sh: backup ok $pathname (Blob)"
    # 위 확인은 새 배포 URL 만 본다. production 도메인이 그 배포를 가리키는지는 따로: 읽기만, 실패해도 경고.
    prod="$PROD_URL"
    got="$(code "$prod/healthz")"
    if [ "$got" = 200 ]; then echo "deploy.sh: production domain $prod/healthz 200"
    else echo "deploy.sh: WARNING production domain $prod/healthz answered $got, want 200" >&2; fi
    echo "deploy.sh: note: if production was rolled back before, $prod stays on the old deployment until: vercel promote $url"
    echo "deploy.sh: ok (commit $sha, new deployment $url)"
    exit 0
  fi
  sleep 2
done
fail "$url/healthz did not answer 200 within 60s after the deploy; $rollback"
