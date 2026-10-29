#!/usr/bin/env bash
# 배포 (#35 H-29, D-15, D-16, D-17). --new 면 1) Management API 로 새 Supabase 프로젝트(O-4, npm run db:new-project), 없으면 현재 env 의 프로젝트에
#   2) 미적용 마이그레이션 → 3) 시드 → 4) 스모크 → 5) 전환: 런타임 env 파일의 SUPABASE_* 4개 교체(env:swap)
#   → deploy/compose.yaml 로 컨테이너 재생성 → /healthz 200 + 새 DB 응답 확인 → 6) 컨테이너 안에서 SQLite 백업(npm run backup).
# 어느 단계든 실패하면 거기서 멈추고 종료코드 ≠ 0. 스모크나 env 교체가 실패하면 env 파일·컨테이너는 그대로다.
# 두 번째 실행은 DB 를 바꾸지 않는다(컨테이너는 같은 env 로 다시 만들어진다).
#
#   set -a; . ./deploy.env; set +a      # SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_DB_URL SUPABASE_ANON_KEY ADMIN_INITIAL_PASSWORD
#   REMATH_ENV_FILE=/etc/remath/server.env scripts/deploy.sh [--with-samples]
#
# 새 프로젝트(--new): 셸에 SUPABASE_ACCESS_TOKEN SUPABASE_ORG_ID(조직 slug) SUPABASE_REGION SUPABASE_DB_PASSWORD ADMIN_INITIAL_PASSWORD.
#   SUPABASE_* 4개는 새 프로젝트에서 받아 임시 env 파일(mktemp, 600, 종료 시 삭제)로 2~6단계에 넘긴다.
#   REMATH_ENV_FILE=/etc/remath/server.env scripts/deploy.sh --new [--with-samples]
#   사전 점검이 모두 통과해야 프로젝트를 만든다(과금). 토큰은 db:new-project 에만 넘어가고 docker·compose·다른 단계·파일에는 없다.
#   전환 전에 실패하면 새 프로젝트는 남겨 두고 ref 를 알린다(사람이 삭제). 어떤 경로도 프로젝트를 지우거나 바꾸지 않는다.
#   NEW_PROJECT_TIMEOUT_S(기본 600): ACTIVE_HEALTHY 대기 한도. DEPLOY_NEW_FAULT=anon_as_service: G3 8단계 실패 경로(스모크가 FAIL 해야 한다).
#
# 복구(--restore <file>, scripts/restore.sh 가 부른다, H-31): --new 와 같고 3단계 시드 대신 백업 파일 적재(db:restore --load),
#   4단계 스모크의 기대 행 수 = 백업 파일의 행 수. 파일 점검(db:restore --check)도 사전 점검이라 프로젝트 생성 전. ADMIN_INITIAL_PASSWORD 는 쓰지 않는다.
#
# REMATH_ENV_FILE(필수): 서버 런타임 env 파일. 컨테이너 설정(이미지 태그·포트·볼륨·사용자)은 deploy/compose.yaml 만 정한다.
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
# 토큰은 내보내지 않는 셸 변수로만 들고 db:new-project 한 번에만 넘긴다: docker·compose·다른 npm 단계의 env 에 없다.
token="${SUPABASE_ACCESS_TOKEN:-}"; unset SUPABASE_ACCESS_TOKEN

fail() { echo "deploy.sh: $*" >&2; exit 1; }
for tool in node npm psql docker curl; do
  command -v "$tool" >/dev/null || fail "$tool is not installed (needed on the deploy host; psql = postgresql-client)"
done
docker info >/dev/null 2>&1 || fail "the Docker daemon is not reachable (docker info failed)"
docker compose version >/dev/null 2>&1 || fail "docker compose (v2 plugin) is not installed"
if [ -n "$new" ]; then need=(SUPABASE_ORG_ID SUPABASE_REGION SUPABASE_DB_PASSWORD); [ -n "$token" ] || fail "SUPABASE_ACCESS_TOKEN is not set"
else need=(SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_DB_URL SUPABASE_ANON_KEY); fi
if [ -n "$restore" ]; then unset ADMIN_INITIAL_PASSWORD   # 백업의 관리자 해시가 돌아온다: 어느 단계도 읽지 않게
else need+=(ADMIN_INITIAL_PASSWORD); fi
for v in "${need[@]}" REMATH_ENV_FILE; do
  [ -n "${!v:-}" ] || fail "$v is not set"
done
[ -f "$REMATH_ENV_FILE" ] || fail "REMATH_ENV_FILE $REMATH_ENV_FILE is not a file"
REMATH_ENV_FILE="$(realpath "$REMATH_ENV_FILE")"
export REMATH_ENV_FILE
if [ -n "$restore" ]; then
  [ -f "$restore" ] || fail "backup file $restore is not a file"
  restore="$(realpath "$restore")"   # npm -w server 는 server/ 에서 돈다
fi

cd "$(dirname "$0")/.."
compose=(docker compose -f deploy/compose.yaml)
"${compose[@]}" config -q || fail "deploy/compose.yaml is invalid with the current REMATH_* settings"
host="${REMATH_BIND:-127.0.0.1}"; [ "$host" = 0.0.0.0 ] && host=127.0.0.1   # compose.yaml 의 포트 바인딩과 같은 주소
base="http://$host:${REMATH_PORT:-3000}"
# 백업이 아니거나 테이블·열이 빠졌으면 여기서 멈춘다: 프로젝트를 만들기 전.
[ -z "$restore" ] || npm run --silent db:restore -w server -- --check "$restore" || fail "$restore is not a usable backup file"

if [ -n "$new" ]; then
  tmp_env="$(mktemp)"; ref= switched=
  # 전환 전 실패 = 새 프로젝트는 쓰이지 않는다: ref 를 알리고 남겨 둔다(db:new-project 자신의 실패는 그 CLI 가 알린다).
  trap 'st=$?; rm -f "$tmp_env"; [ $st -ne 0 ] && [ -n "$ref" ] && [ -z "$switched" ] && echo "deploy.sh: new Supabase project $ref is left in place (not switched to); delete it by hand in the dashboard" >&2; exit $st' EXIT
  echo "== 1/6 new Supabase project"
  SUPABASE_ACCESS_TOKEN="$token" npm run --silent db:new-project -w server -- "$tmp_env"
  unset token
  # source 하지 않는다: 값(DB 비밀번호 등)을 셸 문법으로 해석하지 않게 줄마다 첫 = 에서 나눈다.
  while IFS= read -r line; do export "${line%%=*}=${line#*=}"; done < "$tmp_env"
  ref="${SUPABASE_URL#https://}"; ref="${ref%%.*}"
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
  npm run --silent db:seed -w server "${with_samples[@]}"
  echo "== 4/6 smoke"
  npm run --silent db:smoke -w server "${with_samples[@]}"
fi
echo "== 5/6 switch to $SUPABASE_URL"
npm run --silent env:swap -w server   # 실패하면 set -e 로 여기서 끝: 컨테이너는 그대로
switched=1
rollback="roll back by hand: mv $REMATH_ENV_FILE.prev $REMATH_ENV_FILE && ${compose[*]} up -d --force-recreate"
"${compose[@]}" up -d --force-recreate || fail "docker compose up failed; $rollback"

code() { curl -s -o /dev/null -w '%{http_code}' "$@" || true; }   # 연결 실패 = 000
for _ in $(seq 30); do
  if [ "$(code "$base/healthz")" = 200 ]; then
    # /healthz 는 DB 를 보지 않는다. 모르는 로그인 쿠키 → 서버가 새 env 의 DB 에서 auth_sessions 를 조회해 401.
    # URL·키가 틀려 DB 를 못 읽으면 500 이다.
    got="$(code -H "Cookie: remath_teacher=deploy-check-$RANDOM" "$base/api/auth/me")"
    [ "$got" = 401 ] || fail "GET /api/auth/me with an unknown cookie answered $got, want 401 (server cannot query the new DB); $rollback"
    echo "deploy.sh: switched ($base/healthz 200, new DB answers)"
    echo "== 6/6 backup"
    # 방금 만든 컨테이너 안에서 돈다: 새 env(SUPABASE_*, BACKUP_*)와 compose.yaml 의 백업 볼륨을 그대로 쓴다.
    "${compose[@]}" exec -T server npm run --silent backup \
      || fail "backup failed (the switch is done and the server is running); retry: ${compose[*]} exec server npm run backup"
    echo "deploy.sh: ok"
    exit 0
  fi
  sleep 2
done
fail "$base/healthz did not answer 200 within 60s after recreating the container; $rollback"
