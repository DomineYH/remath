#!/usr/bin/env bash
# 복구 (#35 H-31, V9·V10 #78): 새 Supabase 프로젝트에 SQLite 백업(remath-<YYYYMMDD>.sqlite)을 넣고 Vercel production 을 그리로 전환한다.
# 백업 파일은 Vercel Blob 비공개 저장소에서 내려받는다(README "운영 › Blob 백업에서 복구").
# deploy.sh --new 와 같은 1·2·4·5·6단계, 3단계만 시드 대신 백업 적재(server/src/cli/restore.ts). 이전 프로젝트는 그대로 남는다.
# 모든 로그인은 무효(auth_sessions 미복구), AI 키는 다시 등록해야 한다(key_ciphertext 미백업). ADMIN_INITIAL_PASSWORD 는 쓰지 않는다.
#
#   셸: SUPABASE_ACCESS_TOKEN SUPABASE_ORG_ID(조직 slug) SUPABASE_REGION SUPABASE_DB_PASSWORD
#   REMATH_ENV_FILE=~/.config/remath/prod.env scripts/restore.sh remath-20261028.sqlite
set -euo pipefail
if [ $# -ne 1 ] || [ "${1#-}" != "$1" ]; then
  echo "restore.sh: usage: scripts/restore.sh <remath-YYYYMMDD.sqlite>" >&2; exit 2
fi
exec "$(dirname "$0")/deploy.sh" --restore "$1"
