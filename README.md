# ReMath

Misconception questioning simulator for preservice teachers. Product spec: `prd/`, terms: `GLOSSARY.md`, decisions: `docs/adr/`.

Stage 1 is a client-only app (`client/`) talking to a mock API in the browser. Workspaces: `client`, `shared` (zod API contract), `prompts`, `db/seed`.

## Setup

```sh
nvm use            # Node 24 (.nvmrc)
npm ci
npx playwright install chromium
```

Mock mode (local dev only): put `VITE_MOCK_ADMIN_PASSWORD=<8+ chars, letters and numbers>` in `client/.env.development.local`, then run `npm run dev:mock -w client`. Sign in as admin at `/admin` with ID `admin`. Never deploy a mock build. `client/.env.example` lists the keys.

## Tests

Run all five before a change is done. CI (`.github/workflows/ci.yml`) runs the same commands.

```sh
npm run typecheck     # tsc --noEmit in every workspace
npm run lint          # ESLint (screens may not import the HTTP/mock API; screen copy only through the i18n dict) + lint:env (VITE_MOCK_ADMIN_PASSWORD only inside the mock module)
npm test              # Vitest unit tests: shared contract, Api ↔ route table, turn engine, prompts, review checks, mock API (incl. practice sessions and turns, users·groups, scenario create·review·publish·delete, teacher exposure walk, sessions CSV, AI settings, audit rows)
npm run e2e           # Playwright in mock mode: walking skeleton (signup, admin login, toggles), the admin scenario list, the admin test chat, users·groups → practice → chat → My history → admin Conversations + CSV file, the scenario wizard → publish → group → teacher, AI settings, and the 400×800 smoke (no page-level horizontal scroll, one-line top bar, menus·dropdown·panel by keyboard, dark mode, EN↔한)
npm run check:bundle  # production build has no mock storage key, mock marker or admin password; a mock build has all three
```

`npm test` also runs the stage 2 server and DB suites; neither needs a server or Supabase:

- Server unit (T-1, `server/**/*.test.ts`): realm resolution, the login failure counter, the CSV generator byte-identical to the mock `csv()`, `TurnEvent` → SSE frame → `sse()` round trip, the backup column set (no `key_ciphertext`) and the restore FK order, plus the CLIs (migrate, seed, smoke, new project, deploy.sh/restore.sh with a fake Vercel CLI) against fakes.
- DB (T-3, PGlite, `db/migrations/*.test.ts`): applies 0001–0006 in an in-process Postgres, refuses a second apply, `teacher_scenarios`, anon/authenticated denied, service_role bypass, the one-active-session index, and the atomicity of the SQL functions (`claim_turn`, `record_turn` incl. its turn deadline, password change, session start, admin writes).

`npm run test:http -w server` (T-2) needs a running server and a Supabase project, so it is not in `npm test` or CI (O-11); see "HTTP run" below.

### Seam A groups and targets

The API-boundary suites in `client/src/api/mock/*.test.ts` reach the server only through a target from `client/src/api/seam.ts`: `api(realm)` is this browser, `browser()` another browser (own cookie jar) on the same server. The default target is the mock (`mockTarget`); `useTarget(make)` swaps in another one (the HTTP run). Groups named `[mock] …` (`describeMock`) are skipped on an injected target.

| Target | Groups (file) |
|---|---|
| any (HTTP-runnable) | A-1 teacher exposure (exposure) · A-2 practice-session rules, A-2 turn rules, A-3 turn pipeline, A-6 admin state (sessions) · sample scenarios, A-4 create·update·review·publish·delete, A-10 providers (scenarios) · A-5 users, groups, getPractice (admin) · A-5 signup·validation, password change, logout·realms (mock) · A-7 sessions CSV, A-10 AI settings (logs) |
| mock only | A-9 initial state, admin password from env, storage; A-8 audit helper (mock) · A-2 turn rules mid-stream (409 while streaming, dropped stream), A-2 reload, `turnLimit` (sessions) · A-4 stored compiled prompt, `templates` c7 (scenarios) · A-10 stored keys, A-8 audit log (logs) · A-8 user·group rows (admin) · A-8 scenario rows (scenarios) |

HTTP groups assert on `Api` results only: no store reads, and time values (`started_at`, `created_at`, …) only for presence and order. An injected target must be a server seeded like the mock (the five samples), reset between tests, and passes its admin password to `useTarget` (it becomes `ADMIN_PW`).

### HTTP run (`npm run test:http -w server`)

Runs the HTTP-runnable groups above against a real server through `createHttpApi` (T-2). Not part of `npm test` or CI (O-11). Out of scope: A-8 audit (the SQL smoke covers it) and A-9 initial state (the seed smoke covers it); the run prints this too.

```sh
cd server
MOCK_LLM=1 COOKIE_SECURE=false PORT=3946 node --env-file=$HOME/.config/remath/dev.env --import ./src/raw-hooks.ts src/index.ts &   # the server under test
ENV_FILE=$HOME/.config/remath/dev.env SERVER_URL=http://127.0.0.1:3946 npm run test:http
```

- Env: `SERVER_URL`, `DEV_ADMIN_PASSWORD` (the server's admin password, injected as `ADMIN_PW`), `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`. `ENV_FILE` loads them from a file.
- Target DB: the dev project with the migrations and the seed with samples, admin password = `DEV_ADMIN_PASSWORD`. Once, with `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_DB_URL` of the dev project in the shell: `npm run db:migrate -w server`, then `ADMIN_INITIAL_PASSWORD="$DEV_ADMIN_PASSWORD" npm run db:seed -w server -- --with-samples` (idempotent).
- Each browser is a cookie-jar `fetch` (`server/src/test-http/jar.ts`): it keeps `set-cookie` (Path, Max-Age/Expires) and sends the `cookie` header; `browser()` is a new jar; a logout's expired cookie empties it.
- Known state (`server/src/test-http/reset.ts`): **destructive, dev project only.** It refuses to run unless `SUPABASE_URL` contains the dev project ref `ezzufgvulfwygojibujv`. At the start it snapshots the admin password hash, the five samples (`gabriel`, `hajun`, `jiwoo`, `noah`, `seoyeon`) with their translations, and `ai_settings`. Before every test and once at the end it deletes, through the Data API, every teacher (with their sessions, turns, memberships and logins), every session, every group, every non-sample scenario and the audit rows written since the run started, then writes the snapshot back (a changed admin password goes back through `change_password`, which ends every admin login). `schema_migrations` is untouched; no DDL. Never point it at a database whose data you need.

## 운영

실서버는 Vercel 프로젝트 `remath`(scope `domines-projects`, Hobby)다(V1·V3·V10). `client/dist`는 정적 CDN, `/api/*`·`/healthz`는 Node 함수 하나(`dub1`)이고 DB는 Supabase다. Production 배포는 운영자 머신에서 `scripts/deploy.sh`로만 한다. Git 연동은 PR Preview만 만든다(main 병합은 실서버를 바꾸지 않는다). 아래 명령은 모두 운영자 머신의 저장소 루트에서 실행한다. 실서버 G4 수용 절차는 [`docs/g4-runbook.md`](docs/g4-runbook.md)이고, G3 절차 [`docs/g3-runbook.md`](docs/g3-runbook.md)는 이전 Docker 경로의 기록이다.

### 전제

- **운영자 머신**: Node 24·npm(저장소에서 `npm ci`), `psql`(postgresql-client), `curl`, `git`, Vercel CLI(`npm i -g vercel`), 확인용 `sqlite3`.
- **Vercel**: `vercel login`(계정이 프로젝트 `remath`에 접근할 수 있어야 한다) → 저장소 루트에서 `vercel link`(scope `domines-projects`, 프로젝트 `remath`). `.vercel/project.json`이 생긴다(git 제외). Production 도메인은 **`https://remath-eight.vercel.app`**이다(`remath.vercel.app`은 다른 사람의 사이트). 확인(읽기만): `vercel project inspect remath`의 Domains, 또는 대시보드 프로젝트 → Settings → Domains. 바뀌면 `REMATH_PROD_URL`로 준다. Production env에 `CRON_SECRET`(Sensitive)과 Blob 비공개 저장소 연결(`BLOB_READ_WRITE_TOKEN`)이 이미 있다.
- **배포는 HEAD 커밋에서**: `deploy.sh`는 깨끗한 git 트리만 받고, `git archive HEAD` 사본(`.git` 없음)에서 `vercel deploy --prod`를 실행한다. Hobby는 HEAD 커밋 작성자가 Vercel 계정에 없으면 CLI 배포를 막기 때문이다. 빌드는 Vercel(iad1)에서 `npm ci` + `npm run build:vercel`로 돈다. 빌드는 DB에 닿지 않는다.
- **Supabase**: 조직의 Personal access token(`SUPABASE_ACCESS_TOKEN`), 조직 **slug**(`SUPABASE_ORG_ID`), 리전, 새 프로젝트의 DB 비밀번호. 무료 플랜은 조직당 활성 프로젝트 2개까지다: 한도에서 `deploy.sh --new`·`restore.sh`는 HTTP 400으로 실패하고 아무것도 만들지 않는다. 안 쓰는 프로젝트를 대시보드에서 일시 중지하거나 지운다.
- **HTTPS**: `*.vercel.app`은 HTTPS다. `COOKIE_SECURE`는 기본값(true)이고 production에는 넣지 않는다(`deploy.sh`가 `COOKIE_SECURE=false`를 거절한다).

### env 세 군데

1. **production 런타임 env 파일**(`REMATH_ENV_FILE`, 저장소 밖, `chmod 600`). `deploy.sh`가 읽어 Vercel Production env에 넣는다. 스크립트는 이 파일을 고치지 않는다. 처음에는 직접 만든다:

   ```sh
   umask 077; printf 'MOCK_LLM=0\nKEY_VAULT_SECRET=%s\n' "$(openssl rand -base64 32)" > ~/.config/remath/prod.env
   # 이어서 CRON_SECRET=<Vercel Production 에 이미 있는 값> 한 줄을 편집기로 넣는다(값을 셸 기록·출력에 남기지 않는다)
   ```

   형식은 한 줄 `KEY=value`, 값은 첫 `=` 뒤 글자 그대로(따옴표·`$` 치환 없음, 줄 끝 CR은 뗀다). 넣는 이름: `MOCK_LLM`·`CRON_SECRET`(필수), `KEY_VAULT_SECRET`(`MOCK_LLM=0`이면 필수), 선택 `MAX_TURNS`·`TURN_TIMEOUT_MS`·`BACKUP_KEEP`. 파일에 있는 이름만 Vercel에 넣는다: 파일에서 지운 이름은 Vercel에 있던 값이 남는다(`vercel env rm <NAME> --environment production`으로 지운다). `SUPABASE_*`·`PORT`·`BACKUP_DIR`·`COOKIE_SECURE`는 넣지 않는다.
2. **운영자 셸 env**: Supabase 4개(`SUPABASE_URL`·`SUPABASE_SERVICE_KEY`·`SUPABASE_DB_URL`·`SUPABASE_ANON_KEY`, `--new`면 새 프로젝트에서 받는다), Management 변수 4개, `ADMIN_INITIAL_PASSWORD`, `REMATH_ENV_FILE`. 서버에는 들어가지 않는다.

   ```sh
   export REMATH_ENV_FILE=~/.config/remath/prod.env
   export SUPABASE_ACCESS_TOKEN=<토큰> SUPABASE_ORG_ID=<조직 slug> SUPABASE_REGION=<리전> SUPABASE_DB_PASSWORD=<새 DB 비밀번호>
   read -rs ADMIN_INITIAL_PASSWORD && export ADMIN_INITIAL_PASSWORD   # 에코 없이 입력
   ```

   `--new`·`restore.sh`는 1단계 직후 새 프로젝트의 `SUPABASE_*` 4개를 `DEPLOY_ENV_FILE`(기본 = 런타임 env 파일 옆 `deploy.env`, 예: `~/.config/remath/deploy.env`)에 쓴다: umask 077 임시 파일 → `mv`라 600이고, 이미 있던 파일은 `<파일>.prev`(600)로 남는다. 출력에는 경로만 나온다. Vercel에는 Sensitive라 다시 읽을 수 없으므로, 재배포·`admin:reset-password`는 이 파일을 읽는다: `set -a; . ~/.config/remath/deploy.env; set +a`.
3. **Vercel 프로젝트 env**: Production은 `deploy.sh` 5단계가 쓴다(아래 표). Preview는 dev DB + `MOCK_LLM=1`(V10)이고 손으로 관리한다. env 값은 배포를 만들 때 고정된다: env를 바꿔도 이미 떠 있는 배포는 그대로이고, 다음 배포부터 반영된다.

변수 이름 목록은 `.env.example`.

### 환경변수 (#35 B절, V13)

"Vercel" = Production env(deploy.sh가 씀), "로컬" = `server/.env`·운영자 셸.

| 변수 | 출처 | 기본값 | 어디 | 읽는 곳 | 비고 |
|---|---|---|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | PRD 7절 5단계, ADR-0003 3항 | 없음(필수) | Vercel(Sensitive) + 로컬 | 서버, `backup`, `admin:reset-password`, `db:seed`, `db:smoke` | 서버의 Data API 접속. `deploy.sh`·`restore.sh`가 스모크 통과 뒤 Vercel에 쓴다 |
| `SUPABASE_DB_URL` | 티켓 11 SPEC §3 | 없음(마이그레이션·복구에 필수) | 로컬만 | `db:migrate`, `db:restore` | `psql` 연결. **Session pooler(5432)**; Transaction pooler 금지. 직접 연결 호스트 `db.<ref>`는 IPv6 전용이라 IPv4에서 안 된다. DB 비밀번호가 들어 있어 Vercel에 넣지 않는다 |
| `SUPABASE_ANON_KEY` | PRD 7절 4단계 "anon 키" | 없음(스모크에 필수) | 로컬만(운영자 셸·`deploy.env`) | `db:smoke` | 스모크 전용. 서버 런타임은 읽지 않으므로 Vercel에 넣지 않는다(#78 결정, V13 목록에서 뺌). 예전에 넣었다면 `vercel env rm SUPABASE_ANON_KEY --environment production`으로 지워도 된다 |
| `ADMIN_INITIAL_PASSWORD` | PRD 7절 3단계 | 없음(`deploy.sh`에 필수) | 운영자 셸만 | `db:seed` | 관리자가 없을 때 1회 argon2id 해시로 저장. 비밀번호 규칙(`Password` zod) 미달이면 시드 실패. 재배포에서도 요구하지만 관리자가 있으면 쓰이지 않는다. `restore.sh`는 쓰지 않는다 |
| `MOCK_LLM` | PRD 8절, Q4 | 없음(필수) | Vercel + 로컬 | 서버, `deploy.sh`(사전 점검) | `0` = 실 공급자(OpenAI·Anthropic·Gemini, 관리자 AI 설정의 키), `1` = 세 역할 모두 목. 그 밖의 값이면 기동 실패. 기동 로그 `llm: live`/`llm: mock`. Production `0`, Preview `1` |
| `KEY_VAULT_SECRET` | PRD 9절, Q6·Q25 | 없음(`MOCK_LLM=0`이면 필수) | Vercel(Sensitive) + 로컬 | 서버, `deploy.sh`(사전 점검) | **3단계** 키 금고(AES-256-GCM)의 비밀. 32바이트(base64 또는 hex 64자): `openssl rand -base64 32`(자동 생성 없음). 없거나 32바이트가 아니면 서버가 요청마다 500, `deploy.sh`·`restore.sh`는 1단계 전에 실패. 비밀을 바꾸면 저장된 키를 복호할 수 없으므로 **모든 키를 다시 등록한다**. 백업에 없다(키 암호문도 없다): 복구 후 키를 다시 등록한다. `MOCK_LLM=1`이면 읽지 않는다 |
| `MAX_TURNS` | GLOSSARY 턴 상한, 티켓 19 | `40` | Vercel(선택) + 로컬 | 서버 | `SessionDetail.turn_limit` |
| `TURN_TIMEOUT_MS` | GLOSSARY 턴 시간 제한, 티켓 19 | `120000` | Vercel(선택) + 로컬 | 서버 | 함수 `maxDuration` 300초 안 |
| `BACKUP_KEEP` | PRD 7절, V9 | `7` | Vercel(선택) + 로컬 | 서버(백업 크론), `backup` | 보관 개수. Vercel: 크론 경로가 Blob에 환경 접두어별로 새것부터 N개만 남긴다. 로컬 CLI: `BACKUP_DIR`에서 넘으면 오래된 파일부터 지운다 |
| `CRON_SECRET` | V9, V13 | 없음 | Vercel(Sensitive, 이미 있음) + production 런타임 env 파일 | 서버(백업 크론), `deploy.sh` 6단계 | `GET /api/cron/backup`의 `Authorization: Bearer <값>`. Vercel Cron이 자동으로 붙인다. 없거나 비면 크론 경로는 늘 401. 런타임 env 파일에는 Vercel에 있는 값과 같은 값을 둔다(5단계가 덮어쓴다). 로그에 남기지 않는다 |
| `BLOB_READ_WRITE_TOKEN` | V9 | 없음 | Vercel(저장소 연결이 자동으로) | 서버(백업 크론, `@vercel/blob`) | 손으로 넣지 않는다 |
| `VERCEL_ENV` | V9 | 없음(로컬) | Vercel이 넣는다 | 서버(백업 크론) | `production`이면 Blob 뿌리, 그 밖은 `<값>/` 접두어 |
| `PORT` | — (O-10) | `3000` | 로컬만 | 서버(`index.ts`) | 로컬 `npm run dev`·`npm start`용 |
| `COOKIE_SECURE` | — (O-10) | `true` | 로컬만 | 서버 | `false`는 HTTP 개발만. production에는 넣지 않는다 |
| `BACKUP_DIR` | PRD 7절 경로 | `backup` | 로컬만 | `backup` | 로컬 CLI(`npm run backup`)의 출력 디렉터리(`server/` 기준). Vercel에서는 쓰지 않는다 |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_ORG_ID`, `SUPABASE_REGION`, `SUPABASE_DB_PASSWORD` | PRD 7절 1단계 "Management API" (O-4) | 없음(`--new`·`restore.sh`에 필수) | 운영자 셸만 | `deploy.sh --new`, `restore.sh` | `SUPABASE_ORG_ID` = 조직 slug. 토큰은 `db:new-project`에만 넘어간다 |
| `REMATH_ENV_FILE` | V10 | 없음(필수) | 운영자 셸만 | `deploy.sh`, `restore.sh` | production 런타임 env 파일 경로(위 1) |
| `REMATH_PROD_URL` | #78 | `https://remath-eight.vercel.app` | 운영자 셸만 | `deploy.sh`(사전 점검·끝) | 이 프로젝트의 production 도메인(`remath.vercel.app`은 남의 사이트다). 사전 점검이 `vercel alias ls`로 그 뒤의 배포를 찾아 되돌리기 안내에 넣고, 끝에 `/healthz`를 읽기만 한다(200 아니면 경고) |
| `DEPLOY_ENV_FILE` | #78 | `REMATH_ENV_FILE` 옆 `deploy.env` | 운영자 셸만 | `deploy.sh --new`, `restore.sh` | 새 프로젝트의 `SUPABASE_*` 4개를 남기는 파일(600, 이전 판 `.prev`). 재배포에서 `set -a; . <파일>; set +a`로 읽는다 |
| `NEW_PROJECT_TIMEOUT_S` | O-4 | `600` | 운영자 셸만 | `db:new-project` | 새 프로젝트 `ACTIVE_HEALTHY` 대기 한도 |
| `DEPLOY_NEW_FAULT` | G3 | 없음 | 운영자 셸만 | `db:new-project` | G3 8단계 전용: `anon_as_service`면 anon 키 자리에 service key를 적어 스모크가 FAIL 해야 한다 |

### 명령과 실패 시 상태

**`scripts/deploy.sh --new [--with-samples]`** — 새 서버(H-29, 사용자 스토리 19·21·22·25, V10).
0. 사전 점검(아무것도 만들기 전): 도구(`node npm psql curl git vercel`), `vercel whoami`, `.vercel/project.json`, 깨끗한 git 트리(`git status`가 실패해도 멈춘다), 셸 변수, 런타임 env 파일(`MOCK_LLM` 0/1, `MOCK_LLM=0`이면 `KEY_VAULT_SECRET` 32바이트, `CRON_SECRET` 있음, `MAX_TURNS`·`TURN_TIMEOUT_MS`·`BACKUP_KEEP`은 있으면 양의 정수, `COOKIE_SECURE=false` 아님, 빈 값 줄 없음).
1. Management API로 새 Supabase 프로젝트 생성 → `ACTIVE_HEALTHY` 대기 → 키·pooler 연결 문자열을 임시 env 파일(600, 종료 시 삭제)로 받고, 같은 4개를 `DEPLOY_ENV_FILE`(600)에 남긴다(`deploy.sh: new project's SUPABASE_* saved to <파일> (600)`).
2. 미적용 마이그레이션 적용(새 프로젝트면 0001–0006 전부).
3. 시드: 관리자 `admin` 1(해시만), `ai_settings` 3, `--with-samples`면 샘플 시나리오 5(게시·컴파일본, 번역 10). 데모 계정·그룹·기록은 어떤 옵션에도 없다.
4. 스모크: service key로 관리자 1·`ai_settings` 3(샘플 5·번역 10), anon 키로 `scenarios?select=internal` 거부(42501).
5. 전환: Vercel Production env에 `SUPABASE_URL`·`SUPABASE_SERVICE_KEY` + 런타임 env 파일의 변수를 `vercel env add <NAME> --environment production --sensitive --force`로 쓴다(값은 stdin으로만: 명령줄 인자·출력·파일에 남지 않는다) → HEAD의 `git archive` 사본에서 `vercel deploy --prod`(커밋 SHA와 배포 URL을 출력, 사본은 지운다) → 그 URL의 `/healthz` 200(최대 60초) + 모르는 쿠키로 `/api/auth/me` 401(새 DB 응답) 확인(`the new deployment serves …`). 이 확인은 새 배포 URL만 본다.
6. 첫 백업: 그 URL의 `GET /api/cron/backup`(Bearer는 0600 임시 헤더 파일로 `curl -H @file`) → 200이고 본문이 `{ ok: true, pathname }`이어야 한다. Blob pathname 출력(`remath-<YYYYMMDD>.sqlite`).

끝으로 production 도메인(`REMATH_PROD_URL`, 기본 `https://remath-eight.vercel.app`)의 `/healthz`를 읽기만 한다: 200이 아니면 경고만 한다. 이어서 "롤백한 적이 있으면 도메인은 `vercel promote <url>` 전까지 이전 배포에 남는다"는 안내를 출력한다(아래 "되돌리기"). 마지막 줄은 `deploy.sh: ok (commit <sha>, new deployment <url>)`, 종료코드 0.

- 사전 점검 실패: 아무것도 만들지 않고 Vercel도 건드리지 않는다.
- 프로젝트 생성 뒤 4단계까지 실패: 종료코드 ≠ 0, Vercel은 그대로(이전 배포가 계속 서비스), 새 프로젝트는 남겨 두고 ref를 출력한다 — 사람이 대시보드에서 지운다.
- 5단계 `vercel env add` 실패: 떠 있는 production은 그대로다(env는 배포마다 고정). Production env가 일부만 새 값일 수 있다: 원인을 고치고 출력대로 `set -a; . <DEPLOY_ENV_FILE>; set +a` 뒤 `--new` 없이 다시 실행한다.
- 배포·`/healthz`·DB 응답 실패: 새 배포가 production이 됐을 수 있다. 출력의 되돌리기 명령 `vercel rollback <이전 배포 URL> --yes`를 실행한다(대상은 사전 점검이 `deploy.sh: current production (…): <URL> (<id>)`로 적어 둔 배포, 아래 "되돌리기"). Production env는 새 값으로 남으므로 다음 배포 전에 고친다.
- 6단계 백업만 실패: 전환은 끝났고 서버는 돈다. Vercel 런타임 로그의 `backup failed: …`를 보고, 출력된 `curl -H @<헤더 파일> <url>/api/cron/backup`으로 다시 하거나 다음 크론을 기다린다.
- 이전 Supabase 프로젝트는 어떤 경로도 읽거나 옮기거나 지우지 않는다.

**`scripts/deploy.sh [--with-samples]`** — 같은 DB로 새 코드 배포(사용자 스토리 20). 새 프로젝트를 만들지 않고 셸의 `SUPABASE_*` 4개(= 지금 production의 프로젝트, `--new`가 쓴 `deploy.env`)로 2~6단계를 탄다: 미적용 마이그레이션만, 시드는 멱등이라 건너뛴 것과 같고, 스모크, 같은 값으로 Production env 다시 쓰기, 새 production 배포, 백업(같은 날짜 파일 덮어씀). `deploy.env`는 고치지 않는다:

```sh
set -a; . ~/.config/remath/deploy.env; set +a
read -rs ADMIN_INITIAL_PASSWORD && export ADMIN_INITIAL_PASSWORD   # 관리자가 이미 있으면 쓰이지 않지만 요구한다
scripts/deploy.sh
```
- 마이그레이션은 파일마다 한 트랜잭션: 실패한 파일은 흔적이 없고 앞서 성공한 파일은 남는다. 거기서 멈추고 Vercel은 그대로다. 마이그레이션이 이전 코드와 호환되지 않으면 배포 전까지 떠 있는 서버가 영향을 받는다. 그 밖의 실패 상태는 `--new`와 같다.

**되돌리기** — `vercel rollback <배포 URL 또는 id> --yes`(Hobby는 직전 production 배포까지만), `vercel rollback status`로 확인. 대상 없이 `vercel rollback`만 치면 상태만 보여 주고 되돌리지 않는다(CLI 65.9.0). `deploy.sh`는 사전 점검에서 production 도메인 뒤의 배포를 `vercel alias ls --json`으로 찾아 실패 안내에 그 URL을 넣는다. 찾지 못했으면(첫 배포 전) `vercel ls remath --prod`에서 직전 READY production URL을 고른다. 되돌린 배포는 만들 때의 env(그때의 DB)를 쓴다. DB 스키마는 되돌리지 않는다. 롤백 뒤에는 production 도메인 자동 할당이 꺼진다: 다음 `deploy.sh`의 배포는 출력된 URL에서는 확인되지만 production 도메인(`https://remath-eight.vercel.app`)에는 붙지 않으므로, 확인 뒤 `vercel promote <그 URL>`로 올린다(자동 할당도 다시 켜진다).

**매일 백업(Vercel Cron, V9)** — Vercel Cron이 매일 18:00 UTC(= 03:00 KST, Hobby는 그 한 시간 안 임의 시각, production 배포에서만) `GET /api/cron/backup`을 `Authorization: Bearer $CRON_SECRET`으로 부른다. 일정은 `scripts/build-vercel.mjs`가 Build Output `config.json`의 `crons`에 둔다(`vercel.json`이 아니다). 함수가 `/tmp`에 SQLite 파일을 만들어 Blob 비공개 저장소 `remath-backups`에 올리고, 같은 접두어 안에서 새것부터 `BACKUP_KEEP`개만 남긴다.
- 이름: production은 `remath-<YYYYMMDD>.sqlite`(저장소 뿌리), 그 밖의 환경은 `<VERCEL_ENV>/remath-<YYYYMMDD>.sqlite`(예: `preview/…`, 로컬 `local/…`). 그래서 Preview를 수동 호출해도 production 백업은 지워지지 않는다. 날짜는 함수 시각(UTC) 기준이고 같은 날 다시 돌면 덮어쓴다.
- 내용: 테이블 10개(`users`·`groups`·`group_members`·`scenarios`·`scenario_translations`·`group_scenarios`·`sessions`·`turns`·`ai_settings`·`audit_log`)를 같은 이름·같은 열로, JSONB는 TEXT. `ai_settings.key_ciphertext` 열은 없고 `auth_sessions`·`schema_migrations`는 넣지 않는다. 비밀번호 해시가 들어 있다: 내려받은 파일의 권한·보관 위치에 주의한다.
- 성공: 200 `{ ok, pathname, rows, pruned, deleted }`. 실패: 500 + 로그 1줄 `backup failed: <오류 문구>`. 서비스는 그대로다(H-30).
- 로컬 CLI `npm run backup -w server`(셸에 `SUPABASE_URL`·`SUPABASE_SERVICE_KEY`)는 같은 파일을 `BACKUP_DIR`에 쓴다(임시 파일 → rename, 반쯤 쓴 파일 없음).

**Blob 백업에서 복구** — 백업 파일을 내려받아 아래 `restore.sh`에 넘긴다.
1. 파일 고르기: 대시보드(Storage → `remath-backups` → Browser) 또는 `vercel blob list --prefix remath- --limit 100`(연결된 프로젝트 디렉터리에서).
2. 내려받기: `vercel blob get remath-<YYYYMMDD>.sqlite --access private -o remath-<YYYYMMDD>.sqlite`. 자격은 연결된 프로젝트 또는 셸의 `BLOB_READ_WRITE_TOKEN`에서 온다(토큰을 명령줄 인수로 쓰지 않는다). 대시보드에서 내려받아도 된다.
3. 비밀번호 해시가 들어 있으니 `chmod 600` 하고, 복구가 끝나면 지운다(`*.sqlite`는 git 제외라 저장소 안에 받아도 `deploy.sh`의 깨끗한 트리 검사에 걸리지 않는다).
4. `REMATH_ENV_FILE=… scripts/restore.sh remath-<YYYYMMDD>.sqlite`(아래).

**`REMATH_ENV_FILE=… scripts/restore.sh <backup.sqlite>`** — 백업에서 새 DB로 복구(H-31, 사용자 스토리 24·25). 셸에 Management 변수 4개(`ADMIN_INITIAL_PASSWORD`는 쓰지 않는다).
- 순서: 사전 점검 + 백업 파일 검사(잘못된 파일이면 프로젝트를 만들기 전에 실패) → 새 프로젝트 → 마이그레이션 → 백업 데이터를 FK 순서로 한 트랜잭션에 `psql \copy` → 스모크(기대 행 수 = 백업의 행 수) → Production env·`vercel deploy --prod`·`/healthz`·DB 응답 → 첫 백업.
- `auth_sessions`는 복구하지 않는다: 모든 로그인이 끝나고, 예비교사·관리자는 백업 시점의 같은 비밀번호로 다시 로그인한다. `ai_settings`는 키 없이 돌아오므로(공급자·모델·노력·마스킹만) 관리자 AI 설정에서 키를 다시 등록한다. `KEY_VAULT_SECRET`은 백업에 없으니 런타임 env 파일의 값을 그대로 둔다.
- 실패 시 상태는 `--new`와 같다. 이전 프로젝트는 지우지 않는다.

**`KEY_VAULT_SECRET` 교체** — 재암호화는 없다(Q6). 런타임 env 파일의 값을 바꾸고 `set -a; . ~/.config/remath/deploy.env; set +a` 뒤 `scripts/deploy.sh`(재배포) → 관리자 AI 설정에서 세 역할의 키를 모두 다시 등록한다. 다시 등록하기 전에는 이전 비밀로 만든 키를 복호하지 못해 턴이 실패한다.

**`npm run admin:reset-password`** — 관리자 비밀번호 초기화(H-32, 사용자 스토리 26). 운영자 머신의 터미널에서, `set -a; . ~/.config/remath/deploy.env; set +a`로 production의 `SUPABASE_URL`·`SUPABASE_SERVICE_KEY`를 셸에 넣고 실행한다. 프롬프트에서 에코 없이 두 번 받는다(인수·환경변수·파이프 거부).
- 성공: 일치·비밀번호 규칙 검사 → 해시 갱신과 관리자 로그인 전부 종료를 한 트랜잭션으로 → `audit_log` `admin.password_reset`(actor null, `meta.host` = 운영자 머신 호스트명) → `admin password reset; every admin login has ended`. 예비교사 로그인은 그대로다.
- 실패(불일치·규칙 미달·중단·TTY 아님·인수 있음·관리자 없음): 종료코드 1, 아무것도 바뀌지 않는다.

### 로그 (V15)

서버의 pino 로그(JSON 한 줄)는 Vercel 런타임 로그로 간다: 대시보드 Logs, 또는 `vercel logs --environment production --since 1h`. **Hobby의 런타임 로그 보관은 1시간**이다(Pro 1일, Pro + Observability Plus 30일; Vercel 문서 "Runtime Logs › Limits", 2026-10-31 확인). 요청당 256줄·1MB 상한도 있다. 집계 테이블은 두지 않는다(Q9). 오래 남길 기록이 필요하면 1시간 안에 내려받거나 Pro·Log Drain으로 올린다(코드 변경 없음). 매일 백업의 성공·실패도 이 로그에만 있으니, 백업 확인은 Blob 목록(`vercel blob list --prefix remath-`)으로 한다.

### Vercel 빌드

Vercel은 `vercel.json`의 `npm run build:vercel`(`scripts/build-vercel.mjs`)로 Build Output API v3 `.vercel/output`을 직접 만든다. `client/dist`는 정적 CDN(SPA 폴백)으로, `/api/*`·`/healthz`는 함수 하나로 간다. 함수 진입점은 `server/src/vercel.ts`이고, providers.json과 템플릿을 번들에서 읽는다(디스크 아님). 함수는 `dub1`, `maxDuration` 300, `supportsCancellation`이다. 크론 일정도 이 스크립트가 `config.json`에 쓴다. Git 연동은 PR Preview만 만든다(`vercel.json` `git.deploymentEnabled.main: false`). Production 배포는 `deploy.sh`로만 한다. 로컬 dev·e2e·`npm start`는 그대로 `server/src/index.ts`(단일 프로세스, `@fastify/static`)를 쓴다.

## G2 demo checklist

Mock mode (`npm run dev:mock -w client`, see Setup), in a fresh browser profile. Open `/admin`.

1. Admin login: ID `admin`, the password from `VITE_MOCK_ADMIN_PASSWORD`.
2. Scenarios → "＋ New scenario" → "Fill example (Seoyeon)"; walk the 7 steps (step 6: 7 checks PASS/INFO, tick the 4 confirmations).
3. Step 7 → "Publish". The card shows "Published".
4. Users → "＋ Add user" (nickname + password); Groups → "＋ New group" with that user and the scenario.
5. Sign out, sign in at `/` as that user → pick the student → chat (quick chips, classification toggle, mentor hints) → "End session".
6. The report: leverage bars and the verdict line (no goal or misconception text).
7. "My history" → "View" shows the same report.
8. Admin → Conversations: "View" the transcript, then "Download CSV (n)".
9. Admin → AI settings: key source, model and effort per bot; "Save".
10. Narrow the window to 400px (or DevTools 400×800): no page-level sideways scroll, the ⋯ menu and account dropdown, the internal-state panel folded above the admin test chat; then ☾ (dark) and 한│EN.
