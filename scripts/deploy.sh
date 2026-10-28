#!/usr/bin/env bash
# 재배포 (#35 H-29 2~6단계, D-15, D-16, D-17): 현재 env 의 Supabase 프로젝트에
#   2) 미적용 마이그레이션 → 3) 시드 → 4) 스모크 → 5) 전환: 런타임 env 파일의 SUPABASE_* 4개 교체(env:swap)
#   → deploy/compose.yaml 로 컨테이너 재생성 → /healthz 200 + 새 DB 응답 확인 → 6) 컨테이너 안에서 SQLite 백업(npm run backup).
# 어느 단계든 실패하면 거기서 멈추고 종료코드 ≠ 0. 스모크나 env 교체가 실패하면 env 파일·컨테이너는 그대로다.
# 두 번째 실행은 DB 를 바꾸지 않는다(컨테이너는 같은 env 로 다시 만들어진다).
#
#   set -a; . ./deploy.env; set +a      # SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_DB_URL SUPABASE_ANON_KEY ADMIN_INITIAL_PASSWORD
#   REMATH_ENV_FILE=/etc/remath/server.env scripts/deploy.sh [--with-samples]
#
# REMATH_ENV_FILE(필수): 서버 런타임 env 파일. 컨테이너 설정(이미지 태그·포트·볼륨·사용자)은 deploy/compose.yaml 만 정한다.
set -euo pipefail

with_samples=()
for arg in "$@"; do
  case "$arg" in
    --with-samples) with_samples=(-- --with-samples) ;;
    --new) echo "deploy.sh: --new is not supported until #48 (new Supabase project via Management API)" >&2; exit 2 ;;
    *) echo "deploy.sh: unknown option $arg (usage: scripts/deploy.sh [--with-samples])" >&2; exit 2 ;;
  esac
done

fail() { echo "deploy.sh: $*" >&2; exit 1; }
for tool in node npm psql docker curl; do
  command -v "$tool" >/dev/null || fail "$tool is not installed (needed on the deploy host; psql = postgresql-client)"
done
docker info >/dev/null 2>&1 || fail "the Docker daemon is not reachable (docker info failed)"
docker compose version >/dev/null 2>&1 || fail "docker compose (v2 plugin) is not installed"
for v in SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_DB_URL SUPABASE_ANON_KEY ADMIN_INITIAL_PASSWORD REMATH_ENV_FILE; do
  [ -n "${!v:-}" ] || fail "$v is not set"
done
[ -f "$REMATH_ENV_FILE" ] || fail "REMATH_ENV_FILE $REMATH_ENV_FILE is not a file"
REMATH_ENV_FILE="$(realpath "$REMATH_ENV_FILE")"
export REMATH_ENV_FILE

cd "$(dirname "$0")/.."
compose=(docker compose -f deploy/compose.yaml)
"${compose[@]}" config -q || fail "deploy/compose.yaml is invalid with the current REMATH_* settings"
host="${REMATH_BIND:-127.0.0.1}"; [ "$host" = 0.0.0.0 ] && host=127.0.0.1   # compose.yaml 의 포트 바인딩과 같은 주소
base="http://$host:${REMATH_PORT:-3000}"

echo "== 2/6 migrations"
npm run --silent db:migrate -w server
echo "== 3/6 seed"
npm run --silent db:seed -w server "${with_samples[@]}"
echo "== 4/6 smoke"
npm run --silent db:smoke -w server "${with_samples[@]}"
echo "== 5/6 switch to $SUPABASE_URL"
npm run --silent env:swap -w server   # 실패하면 set -e 로 여기서 끝: 컨테이너는 그대로
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
