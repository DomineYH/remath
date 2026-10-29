#!/usr/bin/env bash
# 복구 (#35 H-31, G3 5·6단계): 새 Supabase 프로젝트에 SQLite 백업(npm run backup 의 remath-<YYYYMMDD>.sqlite)을 넣고 전환한다.
# deploy.sh --new 와 같은 1·2·4·5·6단계, 3단계만 시드 대신 백업 적재(server/src/cli/restore.ts). 이전 프로젝트는 그대로 남는다.
# 모든 로그인은 무효(auth_sessions 미복구), AI 키는 다시 등록해야 한다(key_ciphertext 미백업). ADMIN_INITIAL_PASSWORD 는 쓰지 않는다.
#
#   셸: SUPABASE_ACCESS_TOKEN SUPABASE_ORG_ID(조직 slug) SUPABASE_REGION SUPABASE_DB_PASSWORD
#   REMATH_ENV_FILE=/etc/remath/server.env scripts/restore.sh backup/remath-20261028.sqlite
set -euo pipefail
if [ $# -ne 1 ] || [ "${1#-}" != "$1" ]; then
  echo "restore.sh: usage: scripts/restore.sh <backup/remath-YYYYMMDD.sqlite>" >&2; exit 2
fi
exec "$(dirname "$0")/deploy.sh" --restore "$1"
