#!/usr/bin/env bash
# 재배포 (#35 H-29 2~5단계, D-15, D-16, D-17): 현재 env 의 Supabase 프로젝트에
#   2) 미적용 마이그레이션 → 3) 시드 → 4) 스모크 → 5) 전환: 컨테이너 env 파일의 SUPABASE_* 4개 교체 + 컨테이너 재생성 + 확인.
# 어느 단계든 실패하면 거기서 멈추고 종료코드 ≠ 0 (이후 단계는 돌지 않는다). 스모크 전 실패는 컨테이너·env 파일을 건드리지 않는다.
# 두 번째 실행은 DB 를 바꾸지 않는다(컨테이너는 같은 env 로 다시 만들어진다).
#
#   set -a; . ./deploy.env; set +a      # SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_DB_URL SUPABASE_ANON_KEY ADMIN_INITIAL_PASSWORD
#   REMATH_ENV_FILE=/etc/remath/server.env scripts/deploy.sh [--with-samples]
#
# REMATH_ENV_FILE(필수): 서버 컨테이너의 --env-file. SUPABASE_* 4줄만 바꾸고 나머지 줄(MOCK_LLM 등)은 그대로 둔다. 이전 판은 <파일>.prev.
# REMATH_CONTAINER(기본 remath): 다시 만들 컨테이너. 이미지는 지금 컨테이너의 이미지를 그대로 쓴다.
# REMATH_PUBLISH(기본 3000:3000): docker run -p 값. REMATH_URL(기본 http://localhost:3000): 확인 요청의 주소.
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
SWAP=(SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_DB_URL SUPABASE_ANON_KEY)
for v in "${SWAP[@]}" ADMIN_INITIAL_PASSWORD REMATH_ENV_FILE; do
  [ -n "${!v:-}" ] || fail "$v is not set"
done
[ -f "$REMATH_ENV_FILE" ] && [ -w "$(dirname "$REMATH_ENV_FILE")" ] || fail "REMATH_ENV_FILE $REMATH_ENV_FILE is not a file in a writable directory"
env_file="$(realpath "$REMATH_ENV_FILE")"
container="${REMATH_CONTAINER:-remath}"
publish="${REMATH_PUBLISH:-3000:3000}"
base="${REMATH_URL:-http://localhost:3000}"
docker container inspect "$container" >/dev/null 2>&1 || fail "container $container does not exist (set REMATH_CONTAINER)"
image="$(docker inspect -f '{{.Config.Image}}' "$container")"

cd "$(dirname "$0")/.."

echo "== 2/5 migrations"
npm run --silent db:migrate -w server
echo "== 3/5 seed"
npm run --silent db:seed -w server "${with_samples[@]}"
echo "== 4/5 smoke"
npm run --silent db:smoke -w server "${with_samples[@]}"
echo "== 5/5 switch $container to $SUPABASE_URL"
# 스모크를 통과한 값만 쓴다. 같은 디렉터리의 임시 파일(mktemp = 600) → mv 라 반쯤 쓴 env 파일은 생기지 않는다.
tmp="$(mktemp "$env_file.XXXXXX")"
{
  grep -vE "^($(IFS='|'; echo "${SWAP[*]}"))=" "$env_file" || true
  for v in "${SWAP[@]}"; do printf '%s=%s\n' "$v" "${!v}"; done
} > "$tmp"
cp -p "$env_file" "$env_file.prev"
mv "$tmp" "$env_file"
rollback="roll back by hand: mv $env_file.prev $env_file, then recreate $container from $image"
# docker restart 는 컨테이너를 만들 때의 env 를 그대로 쓴다: 새 env 를 읽게 하려면 다시 만들어야 한다.
docker rm -f "$container" >/dev/null
docker run -d --name "$container" --restart unless-stopped --env-file "$env_file" -p "$publish" "$image" >/dev/null || fail "docker run failed; $rollback"

code() { curl -s -o /dev/null -w '%{http_code}' "$@" || true; }
for _ in $(seq 30); do
  if [ "$(code "$base/healthz")" = 200 ]; then
    # 새 DB 를 보는지: (1) 컨테이너 env 의 SUPABASE_URL 이 스모크한 값, (2) 모르는 로그인 쿠키 → 서버가 그 DB 의
    # auth_sessions 를 조회해 401. URL·키가 틀려 DB 를 못 읽으면 500 이다. (/healthz 는 DB 를 보지 않는다.)
    envs="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container")"
    grep -qxF "SUPABASE_URL=$SUPABASE_URL" <<<"$envs" || fail "$container does not run with the new SUPABASE_URL; $rollback"
    got="$(code -H "Cookie: remath_teacher=deploy-check-$RANDOM" "$base/api/auth/me")"
    [ "$got" = 401 ] || fail "GET /api/auth/me with an unknown cookie answered $got, want 401 (server cannot query the new DB); $rollback"
    echo "deploy.sh: ok ($base/healthz 200, new DB answers)"
    # 6단계(백업)는 #47 이 여기에 붙인다.
    exit 0
  fi
  sleep 2
done
fail "$base/healthz did not answer 200 within 60s after recreating $container; $rollback"
