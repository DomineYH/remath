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

- Server unit (T-1, `server/**/*.test.ts`): realm resolution, the login failure counter, the CSV generator byte-identical to the mock `csv()`, `TurnEvent` → SSE frame → `sse()` round trip, the backup column set (no `key_ciphertext`) and the restore FK order, plus the CLIs (migrate, seed, smoke, env swap, new project, deploy.sh) against fakes.
- DB (T-3, PGlite, `db/migrations/*.test.ts`): applies 0001–0005 in an in-process Postgres, refuses a second apply, `teacher_scenarios`, anon/authenticated denied, service_role bypass, the one-active-session index, and the atomicity of the SQL functions (`claim_turn`, `record_turn` incl. its turn deadline, password change, session start, admin writes).

`npm run test:http -w server` (T-2) needs a running server and a Supabase project, so it is not in `npm test` or CI (O-11); see "HTTP run" below.

The Docker image build (`docker build .`) runs `npm run check:bundle` inside; CI builds the image in a separate `image` job.

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

서버의 배포 단위는 Docker 이미지 1개(서버 + 프로덕션 `client/dist`)이고, 컨테이너는 `deploy/compose.yaml`로만 띄운다(손으로 `docker run` 하지 않는다). 아래 명령은 모두 운영 호스트의 저장소 루트에서 실행한다. G3 수용 절차(8단계, 명령·기대값·확인 방법)는 [`docs/g3-runbook.md`](docs/g3-runbook.md), 실서버 G4 수용 절차는 [`docs/g4-runbook.md`](docs/g4-runbook.md).

### 전제

- **호스트**: Docker 데몬 + Docker Compose v2.30 이상(`env_file` `format: raw`), Node 24·npm(저장소에서 `npm ci`), `psql`(postgresql-client), `curl`, 확인용 `sqlite3`. WSL2 + Docker Desktop도 된다.
- **TLS**: 앞단에 HTTPS 종단(리버스 프록시, 아래 "실서버"의 Caddy)이 있으면 `COOKIE_SECURE`를 넣지 않는다(기본 true). 종단 없는 HTTP 스테이징만 런타임 env 파일에 `COOKIE_SECURE=false`(O-10 (B), 개발·HTTP 스테이징 전용). 이것 없이 HTTP로 열면 브라우저가 `Secure` 쿠키를 보내지 않아 로그인이 유지되지 않는다.
- **Supabase**: 조직의 Personal access token(`SUPABASE_ACCESS_TOKEN`), 조직 **slug**(`SUPABASE_ORG_ID`), 리전, 새 프로젝트의 DB 비밀번호. 무료 플랜은 조직당 활성 프로젝트 2개까지다: 한도에서 `deploy.sh --new`·`restore.sh`는 HTTP 400으로 실패하고 아무것도 만들지 않는다. 안 쓰는 프로젝트를 대시보드에서 일시 중지하거나 지운다.
- **이미지**: 첫 배포 전, 그리고 새 코드를 낼 때마다 `docker build -t remath:latest .`. 빌드 안에서 `npm run check:bundle`이 돌아 목 코드가 섞이면 빌드가 실패한다. compose는 `${REMATH_IMAGE:-remath:latest}` 태그로 컨테이너를 다시 만든다(같은 코드로 재배포하려면 태그를 그대로 둔다).

### env 두 군데

1. **서버 런타임 env 파일**(`REMATH_ENV_FILE`, 절대 경로, 저장소 밖, `chmod 600`). 처음에는 직접 만든다:

   ```sh
   umask 077; printf 'MOCK_LLM=1\nCOOKIE_SECURE=false\n' > /abs/path/remath-server.env   # 스테이징(목 LLM). COOKIE_SECURE 줄은 HTTP 스테이징만
   umask 077; printf 'MOCK_LLM=0\nKEY_VAULT_SECRET=%s\n' "$(openssl rand -base64 32)" > /abs/path/remath-server.env   # 실서버(실 공급자, HTTPS)
   ```

   `deploy.sh`·`restore.sh`가 스모크 통과 뒤 `SUPABASE_URL`·`SUPABASE_SERVICE_KEY`·`SUPABASE_DB_URL`·`SUPABASE_ANON_KEY` 4줄만 써 넣고 나머지 줄은 그대로 둔다(이전 판은 `<파일>.prev`, 600). 형식은 한 줄 `KEY=value`, 값은 첫 `=` 뒤 글자 그대로(따옴표·`$` 치환 없음). `PORT`는 넣지 않는다(호스트 포트는 `REMATH_PORT`).
2. **운영자 셸 env**: Management 변수 4개, `ADMIN_INITIAL_PASSWORD`, `REMATH_*`. 서버 컨테이너에는 들어가지 않는다.

   ```sh
   export REMATH_ENV_FILE=/abs/path/remath-server.env
   export SUPABASE_ACCESS_TOKEN=<토큰> SUPABASE_ORG_ID=<조직 slug> SUPABASE_REGION=<리전> SUPABASE_DB_PASSWORD=<새 DB 비밀번호>
   read -rs ADMIN_INITIAL_PASSWORD && export ADMIN_INITIAL_PASSWORD   # 에코 없이 입력
   ```

변수 이름 목록은 `.env.example`.

### 환경변수 (#35 B절)

| 변수 | 출처 | 기본값 | 읽는 곳 | 비고 |
|---|---|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | PRD 7절 5단계, ADR-0003 3항 | 없음(필수) | 서버, `backup`, `admin:reset-password`, `db:seed`, `db:smoke` | 서버의 Data API 접속. `deploy.sh`·`restore.sh`가 런타임 env 파일에 쓴다 |
| `SUPABASE_DB_URL` | 티켓 11 SPEC §3 | 없음(마이그레이션·복구에 필수) | `db:migrate`, `restore.sh` | `psql` 연결. **Session pooler(5432)**; Transaction pooler 금지. 직접 연결 호스트 `db.<ref>`는 IPv6 전용이라 IPv4 호스트에서 안 된다. `--new`·`restore.sh`는 pooler 문자열을 적는다 |
| `SUPABASE_ANON_KEY` | PRD 7절 4단계 "anon 키" | 없음(스모크에 필수) | `db:smoke` | 스모크 전용. 서버 런타임은 쓰지 않는다 |
| `ADMIN_INITIAL_PASSWORD` | PRD 7절 3단계 | 없음(`deploy.sh`에 필수) | `db:seed` | 운영자 셸만. 관리자가 없을 때 1회 argon2id 해시로 저장. 비밀번호 규칙(`Password` zod) 미달이면 시드 실패. 재배포에서도 요구하지만 관리자가 있으면 쓰이지 않는다. `restore.sh`는 쓰지 않는다 |
| `MAX_TURNS` | GLOSSARY 턴 상한, 티켓 19 | `40` | 서버 | `SessionDetail.turn_limit` |
| `TURN_TIMEOUT_MS` | GLOSSARY 턴 시간 제한, 티켓 19 | `120000` | 서버 | |
| `MOCK_LLM` | PRD 8절, Q4 | 없음(필수) | 서버, `deploy.sh`·`restore.sh`(사전 점검) | `0` = 실 공급자(OpenAI·Anthropic·Gemini, 관리자 AI 설정의 키), `1` = 세 역할 모두 목. 그 밖의 값이면 기동 실패. 기동 로그 `llm: live`/`llm: mock` |
| `BACKUP_KEEP` | PRD 7절 | `7` | 서버(매일 백업), `backup` | 보관 개수. 넘으면 오래된 파일부터 지운다 |
| `BACKUP_AT` | PRD 7절 | `03:00` | 서버 | 매일 백업 시각 `HH:MM`, 컨테이너 로컬 시각(기본 UTC). 런타임 env 파일에 `TZ=Asia/Seoul`을 넣으면 그 시각대(파일명 날짜도) |
| `BACKUP_DIR` | PRD 7절 경로 | `backup` | 서버, `backup` | 컨테이너 작업 디렉터리(`/app/server`) 기준. compose 볼륨이 이 자리라 비우거나 `backup`으로 둔다 |
| `PORT` | — (O-10) | `3000` | 서버 | 로컬 `npm run dev`용. 컨테이너 env 파일에는 넣지 않는다 |
| `COOKIE_SECURE` | — (O-10) | `true` | 서버 | 실서버는 미설정. `false`는 HTTP 스테이징·개발만 |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_ORG_ID`, `SUPABASE_REGION`, `SUPABASE_DB_PASSWORD` | PRD 7절 1단계 "Management API" (O-4) | 없음(`--new`·`restore.sh`에 필수) | `deploy.sh --new`, `restore.sh` | 운영자 셸만, 서버 컨테이너에는 넣지 않는다. `SUPABASE_ORG_ID` = 조직 slug. 토큰은 `db:new-project`에만 넘어간다 |
| `KEY_VAULT_SECRET` | PRD 9절, Q6·Q25 | 없음(`MOCK_LLM=0`이면 필수) | 서버, `deploy.sh`·`restore.sh`(사전 점검) | **3단계** 키 금고(AES-256-GCM)의 비밀. 32바이트(base64 또는 hex 64자): `openssl rand -base64 32`로 만들어 런타임 env 파일에 넣는다(자동 생성 없음). 없거나 32바이트가 아니면 서버 기동 실패, `deploy.sh`·`restore.sh`는 1단계 전에 실패. 비밀을 바꾸면 저장된 키를 복호할 수 없으므로 **모든 키를 다시 등록한다**. 백업에 없다(키 암호문도 없다): 복구 후 키를 다시 등록한다. `MOCK_LLM=1`이면 읽지 않는다 |

운영자 셸에서만 읽는 배포 설정:

| 변수 | 기본값 | 읽는 곳 | 비고 |
|---|---|---|---|
| `REMATH_ENV_FILE` | 없음(필수) | `deploy.sh`, `restore.sh`, `deploy/compose.yaml` | 서버 런타임 env 파일 경로. `docker compose … exec`에도 필요하다 |
| `REMATH_IMAGE` | `remath:latest` | compose | 컨테이너를 만들 이미지 태그 |
| `REMATH_BIND`, `REMATH_PORT` | `127.0.0.1`, `3000` | compose, `deploy.sh`(`/healthz` 주소) | 모든 인터페이스에 열려면 `REMATH_BIND=0.0.0.0` |
| `REMATH_BACKUP_DIR` | `../backup`(= 저장소 루트 `backup/`) | compose | 백업 볼륨의 호스트 쪽. 상대 경로는 `deploy/` 기준. uid 1000(컨테이너 사용자 `node`)이 쓸 수 있어야 한다 |
| `NEW_PROJECT_TIMEOUT_S` | `600` | `db:new-project` | 새 프로젝트 `ACTIVE_HEALTHY` 대기 한도 |
| `DEPLOY_NEW_FAULT` | 없음 | `db:new-project` | G3 8단계 전용: `anon_as_service`면 anon 키 자리에 service key를 적어 스모크가 FAIL 해야 한다 |

### 명령과 실패 시 상태

**`scripts/deploy.sh --new [--with-samples]`** — 새 서버(H-29, 사용자 스토리 19·21·22·25).
1. Management API로 새 Supabase 프로젝트 생성 → `ACTIVE_HEALTHY` 대기 → 키·pooler 연결 문자열을 임시 env 파일(600, 종료 시 삭제)로 받는다.
2. 미적용 마이그레이션 적용(새 프로젝트면 0001–0005 전부).
3. 시드: 관리자 `admin` 1(해시만), `ai_settings` 3, `--with-samples`면 샘플 시나리오 5(게시·컴파일본, 번역 10). 데모 계정·그룹·기록은 어떤 옵션에도 없다.
4. 스모크: service key로 관리자 1·`ai_settings` 3(샘플 5·번역 10), anon 키로 `scenarios?select=internal` 거부(42501).
5. 전환: 런타임 env 파일의 `SUPABASE_*` 4줄 교체 → 컨테이너 재생성 → `/healthz` 200 + 새 DB 응답 확인.
6. 컨테이너 안에서 백업.

끝에 `deploy.sh: ok`, 종료코드 0.

- 사전 점검(도구·Docker·변수·env 파일·`MOCK_LLM=0`이면 `KEY_VAULT_SECRET` 32바이트·compose 설정) 실패: 아무것도 만들지 않는다.
- 프로젝트 생성 뒤 전환 전 실패(마이그레이션·시드·스모크·env 교체): 종료코드 ≠ 0, env 파일·컨테이너 그대로(이전 DB가 계속 서비스), 새 프로젝트는 남겨 두고 ref를 출력한다 — 사람이 대시보드에서 지운다.
- 전환 뒤 실패(컨테이너 재생성·`/healthz`·DB 응답): env 파일은 이미 새 값이다. 출력되는 되돌리기 명령 `mv <파일>.prev <파일> && docker compose -f deploy/compose.yaml up -d --force-recreate`를 실행한다.
- 6단계 백업만 실패: 전환은 끝났고 서버는 돈다. 아래 수동 백업으로 다시 한다.
- 이전 프로젝트는 어떤 경로도 읽거나 옮기거나 지우지 않는다.

**`scripts/deploy.sh [--with-samples]`** — 같은 서버 재배포(사용자 스토리 20). 새 프로젝트를 만들지 않고 셸의 `SUPABASE_*` 4개(= 런타임 env 파일의 현재 값)로 2~6단계를 탄다: 미적용 마이그레이션만, 시드는 멱등이라 건너뛴 것과 같고, 스모크, 같은 값으로 env 교체(`.prev` 갱신), 컨테이너 재생성(`remath:latest`를 새로 빌드했으면 새 코드), 백업(같은 날짜 파일 덮어씀). 셸에 넣기(`source` 하지 않는다):

```sh
while IFS= read -r l; do case $l in SUPABASE_*=*) export "$l";; esac; done < "$REMATH_ENV_FILE"
scripts/deploy.sh
```
- 마이그레이션은 파일마다 한 트랜잭션: 실패한 파일은 흔적이 없고 앞서 성공한 파일은 남는다. 거기서 멈추고 env 파일·컨테이너는 그대로다. 그 밖의 실패 상태는 `--new`와 같다.

**백업** — `docker compose -f deploy/compose.yaml exec server npm run backup` (= 컨테이너 안의 `npm run backup -w server`; 셸에 `REMATH_ENV_FILE` 필요) (H-30, 사용자 스토리 23). 서버도 매일 `BACKUP_AT`에, `deploy.sh`·`restore.sh`도 전환 직후 같은 백업을 만든다.
- 결과: `REMATH_BACKUP_DIR/remath-<YYYYMMDD>.sqlite`(기본 저장소 루트 `backup/`), 출력 `backup ok <파일> {테이블별 행 수}`. 테이블 10개(`users`·`groups`·`group_members`·`scenarios`·`scenario_translations`·`group_scenarios`·`sessions`·`turns`·`ai_settings`·`audit_log`)를 같은 이름·같은 열로, JSONB는 TEXT. `ai_settings.key_ciphertext` 열은 없고 `auth_sessions`·`schema_migrations`는 넣지 않는다. 같은 날짜면 덮어쓰고, `BACKUP_KEEP`개를 넘으면 오래된 순으로 지운다.
- 비밀번호 해시가 들어 있다: 파일 권한·보관 위치에 주의한다.
- 실패: 임시 파일에 쓰고 끝나면 rename 하므로 반쯤 쓴 파일은 없다. 종료코드 ≠ 0, 기존 백업 파일은 그대로.

**`REMATH_ENV_FILE=… scripts/restore.sh <backup.sqlite>`** — 백업에서 새 DB로 복구(H-31, 사용자 스토리 24·25). 셸에 Management 변수 4개(`ADMIN_INITIAL_PASSWORD`는 쓰지 않는다).
- 순서: 백업 파일 검사(잘못된 파일이면 프로젝트를 만들기 전에 실패) → 새 프로젝트 → 마이그레이션 → 백업 데이터를 FK 순서로 한 트랜잭션에 `psql \copy` → 스모크(기대 행 수 = 백업의 행 수) → env 교체·컨테이너 재생성·`/healthz` → 백업.
- `auth_sessions`는 복구하지 않는다: 모든 로그인이 끝나고, 예비교사·관리자는 백업 시점의 같은 비밀번호로 다시 로그인한다. `ai_settings`는 키 없이 돌아오므로(공급자·모델·노력·마스킹만) 관리자 AI 설정에서 키를 다시 등록한다. `KEY_VAULT_SECRET`은 백업에 없으니 런타임 env 파일의 값을 그대로 둔다.
- 전환 전 실패: 종료코드 ≠ 0, env 파일·컨테이너 그대로, 새 프로젝트 ref를 출력하고 남겨 둔다. 이전 프로젝트는 지우지 않는다.

**`KEY_VAULT_SECRET` 교체** — 재암호화는 없다(Q6). 런타임 env 파일의 값을 바꾸고 `docker compose -f deploy/compose.yaml up -d --force-recreate` → 관리자 AI 설정에서 세 역할의 키를 모두 다시 등록한다. 다시 등록하기 전에는 이전 비밀로 만든 키를 복호하지 못해 턴이 실패한다.

**`docker compose -f deploy/compose.yaml exec server npm run admin:reset-password`** — 관리자 비밀번호 초기화(H-32, 사용자 스토리 26; `docker exec -it remath npm run admin:reset-password`와 같다). 터미널 프롬프트에서 에코 없이 두 번 받는다(인수·환경변수·파이프 거부).
- 성공: 일치·비밀번호 규칙 검사 → 해시 갱신과 관리자 로그인 전부 종료를 한 트랜잭션으로 → `audit_log` `admin.password_reset`(actor null, `meta.host`) → `admin password reset; every admin login has ended`. 예비교사 로그인은 그대로다.
- 실패(불일치·규칙 미달·중단·TTY 아님·인수 있음·관리자 없음): 종료코드 1, 아무것도 바뀌지 않는다.

### 실서버(HTTPS, Caddy)

실서버 = 운영자가 준비한 Linux 호스트 + 도메인 + 호스트의 Caddy(Q13·Q26). compose는 그대로다(Caddy 서비스를 더하지 않는다): 컨테이너는 `REMATH_BIND` 기본값 `127.0.0.1`에만 열리고, Caddy가 TLS를 받아 그리로 넘긴다. `REMATH_BIND=0.0.0.0`으로 바꾸지 않는다.

`/etc/caddy/Caddyfile`(`<domain>`의 DNS A 레코드가 이 호스트를 가리켜야 Caddy가 인증서를 받는다):

```caddyfile
# ReMath 실서버: HTTPS 종단 → compose 컨테이너(127.0.0.1:3000)
<domain> {
	reverse_proxy 127.0.0.1:3000
}
```

`sudo systemctl reload caddy` 뒤 `curl -s https://<domain>/healthz` → `{"ok":true}`. 런타임 env 파일은 `MOCK_LLM=0`, `KEY_VAULT_SECRET`, `COOKIE_SECURE` 없음(기본 true, HTTPS라 `Secure` 쿠키가 돈다). `REMATH_PORT`를 바꿨으면 Caddyfile의 포트도 맞춘다. 수용 절차는 [`docs/g4-runbook.md`](docs/g4-runbook.md).

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
