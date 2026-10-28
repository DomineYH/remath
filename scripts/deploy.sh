#!/usr/bin/env bash
# 재배포 (#35 H-29 2~5단계, D-15, D-16, D-17): 현재 env 의 Supabase 프로젝트에
#   2) 미적용 마이그레이션 → 3) 시드 → 4) 스모크 → 5) 서버 컨테이너 재시작 + GET /healthz 200.
# 어느 단계든 실패하면 거기서 멈추고 종료코드 ≠ 0 (이후 단계는 돌지 않는다). 두 번째 실행은 아무것도 바꾸지 않는다.
#
#   set -a; . ./deploy.env; set +a      # SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_DB_URL SUPABASE_ANON_KEY ADMIN_INITIAL_PASSWORD
#   scripts/deploy.sh [--with-samples]
#
# REMATH_CONTAINER(기본 remath): 재시작할 서버 컨테이너. REMATH_HEALTHZ_URL(기본 http://localhost:3000/healthz).
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
for v in SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_DB_URL SUPABASE_ANON_KEY ADMIN_INITIAL_PASSWORD; do
  [ -n "${!v:-}" ] || fail "$v is not set"
done
container="${REMATH_CONTAINER:-remath}"
healthz="${REMATH_HEALTHZ_URL:-http://localhost:3000/healthz}"
docker container inspect "$container" >/dev/null 2>&1 || fail "container $container does not exist (set REMATH_CONTAINER)"

cd "$(dirname "$0")/.."

echo "== 2/5 migrations"
npm run --silent db:migrate -w server
echo "== 3/5 seed"
npm run --silent db:seed -w server "${with_samples[@]}"
echo "== 4/5 smoke"
npm run --silent db:smoke -w server "${with_samples[@]}"
echo "== 5/5 restart $container"
docker restart "$container" >/dev/null
for _ in $(seq 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$healthz")" = 200 ]; then
    echo "deploy.sh: ok ($healthz 200)"
    # 6단계(백업)는 #47 이 여기에 붙인다.
    exit 0
  fi
  sleep 2
done
fail "$healthz did not answer 200 within 60s after restart"
