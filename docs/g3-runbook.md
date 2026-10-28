# G3 수용 런북 (스테이징)

#35 "G3 수용 절차" 1~8단계를 그대로 실행하는 순서표다. 각 단계는 **명령 → 기대값 → 확인**이다. 기대값과 다르면 거기서 멈추고 출력과 함께 기록한다. 명령·변수·실패 시 상태의 설명은 README "운영".

## 0. 준비

- 호스트: README "운영 › 전제"(Docker + compose v2.30+, Node 24, `psql`, `curl`, `sqlite3`). 저장소는 검수할 커밋으로 체크아웃하고 루트에서 실행한다.
- 이미지: `npm ci && docker build -t remath:latest .` → 종료코드 0.
- 런타임 env 파일(HTTP 스테이징이라 `COOKIE_SECURE=false`, O-10 (B)):

  ```sh
  umask 077; printf 'MOCK_LLM=1\nCOOKIE_SECURE=false\n' > /abs/path/remath-server.env
  ```

- 운영자 셸:

  ```sh
  export REMATH_ENV_FILE=/abs/path/remath-server.env
  export SUPABASE_ACCESS_TOKEN=<토큰> SUPABASE_ORG_ID=<조직 slug> SUPABASE_REGION=<리전> SUPABASE_DB_PASSWORD=<새 DB 비밀번호>
  read -rs ADMIN_INITIAL_PASSWORD && export ADMIN_INITIAL_PASSWORD
  ```

- 빈 `backup/`: `mkdir -p backup && ls -A backup` → 출력 없음. uid 1000이 쓸 수 있어야 한다(`ls -ln backup`).
- 도우미(같은 셸에서 끝까지 쓴다). `W`에는 쿠키·비밀이 담긴 사본이 생기므로 마지막에 지운다.

  ```sh
  W=$(mktemp -d)                          # 700
  B=http://127.0.0.1:3000                 # REMATH_BIND/REMATH_PORT 를 바꿨으면 맞춘다
  dc() { docker compose -f deploy/compose.yaml "$@"; }
  envv() { grep "^$1=" "$REMATH_ENV_FILE" | cut -d= -f2-; }       # 런타임 env 파일의 값 (source 하지 않는다)
  q() { psql "$(envv SUPABASE_DB_URL)" -XAt -c "$1"; }             # 지금 서비스 중인 DB 에 SQL
  code() { curl -s -o /dev/null -w '%{http_code}\n' "$@"; }
  json() { node -p "const d=JSON.parse(fs.readFileSync(0)); $1"; }  # 표준입력 JSON 에서 값 하나
  login() { curl -s -c "$W/$1.jar" -H 'content-type: application/json' -d "{\"nickname\":\"$3\",\"password\":\"$4\"}" "$B$2" -o /dev/null -w '%{http_code}\n'; }
  TABLES="users groups group_members scenarios scenario_translations group_scenarios sessions turns ai_settings audit_log"
  ```

### 무료 플랜 슬롯 계획

무료 플랜은 조직당 **활성 프로젝트 2개**다. 한도에서 `deploy.sh --new`·`restore.sh`는 HTTP 400으로 실패하고 아무것도 만들지 않는다(그 경우 단계를 다시 하면 된다).

| 시점 | 활성 프로젝트 | 필요한 빈자리 |
|---|---|---|
| 1단계 전 | 다른 활성 프로젝트가 없어야 한다(또는 1개 이하) | A 1개 + 6단계 B 1개 |
| 6단계 | A(이전 서비스) + B(복구본) | 2개 다 찬다 |
| 8단계 전 | **A를 일시 중지**한다(6단계에서 "A가 남아 있다"를 확인한 뒤): 대시보드 → Project Settings → General → Pause project, 또는 Management API `POST /v1/projects/<ref A>/pause` | 실패 경로의 프로젝트 C 1개 |
| 끝 | B(서비스) + C(남겨진 실패본) | C·A는 사람이 대시보드에서 지운다(PRD 7절: 자동 삭제 없음) |

조직에 dev 프로젝트 등 다른 활성 프로젝트가 있으면 그만큼 앞당겨 일시 중지한다. 일시 중지한 프로젝트도 대시보드 목록에 남는다.

## 1. 새 서버: `deploy.sh --new --with-samples`

```sh
scripts/deploy.sh --new --with-samples; echo "exit $?"
```

기대값:
- `== 1/6` … `== 6/6` 순서, 스모크 줄이 모두 `ok`:
  `ok   admin user: 1 rows, want 1` · `ok   ai_settings: 3 rows, want 3` · `ok   sample scenarios published: 5 rows, want 5` · `ok   sample translations: 10 rows, want 10` · `ok   anon denied scenarios.internal: HTTP 401 code 42501`(401 또는 403, code `42501`).
- `deploy.sh: switched (…/healthz 200, new DB answers)`, `backup ok …`, `deploy.sh: ok`, **`exit 0`**.

확인:

```sh
envv SUPABASE_URL                                   # https://<ref A>.supabase.co — ref A 를 적어 둔다
q "select version from schema_migrations order by 1"
q "select (select count(*) from users where role='admin'), (select count(*) from ai_settings), (select count(*) from scenarios), (select count(*) from scenario_translations), (select count(*) from users)"
A=$(envv SUPABASE_ANON_KEY); curl -s -w ' %{http_code}\n' "$(envv SUPABASE_URL)/rest/v1/scenarios?select=internal" -H "apikey: $A" -H "Authorization: Bearer $A"; unset A
curl -s -w ' %{http_code}\n' "$B/healthz"
D=$(dc exec -T server date +%Y%m%d); ls -l "backup/remath-$D.sqlite"
```

- `schema_migrations` = `0001` `0002` `0003` `0004` **4행**(#35는 1행이라 적었지만 그 뒤 0002~0004가 더해졌다).
- 행 수 = `1|3|5|10|1`(관리자 1, `ai_settings` 3, 시나리오 5, 번역 10, 사용자는 관리자뿐).
- anon 요청 = 401(또는 403), 본문 `"code":"42501"`.
- `/healthz` = `{"ok":true} 200`.
- `backup/remath-<D>.sqlite`가 있다. `D`는 컨테이너 시각 기준 날짜(기본 UTC)라 호스트 날짜와 다를 수 있다.

## 2. 브라우저: G2 데모 체크리스트를 목 없이

`$B/`(예: `http://127.0.0.1:3000/`)를 새 브라우저 프로필로 연다. README "G2 demo checklist" 1~9단계를 그대로 하되:
- 관리자 로그인 = ID `admin`, 비밀번호 = `ADMIN_INITIAL_PASSWORD`.
- 4단계에서 만든 예비교사(닉네임·비밀번호)를 아래 셸 변수로 적어 둔다: `T=<닉네임>; read -rs TP`. 그룹에는 1단계에서 만든 시나리오만 넣는다(샘플 5개는 **미할당**으로 둔다 — 3단계 403 확인용).
- 9단계 AI 설정: 저장이 성공하고 다시 열면 마스킹된 키·모델·노력이 보인다(키 원문은 저장하지 않는다, O-7).

기대값:
- 1~9단계가 목 모드와 같은 화면으로 통과한다. 목 흔적 없음: `curl -s "$B/" | grep -c remath.mock` → `0`.
- **다른 브라우저 프로필**에서 같은 예비교사로 로그인 → 내 기록에 같은 세션·같은 리포트.
- **두 탭 동시 시작**: 한 탭에서 학생을 골라 대화를 시작한 채, 다른 탭에서 다른(또는 같은) 학생을 시작 → 먼저 종료하라는 안내(409 `session_active`). 셸로도 확인:

  ```sh
  login t /api/auth/login "$T" "$TP"                                   # 200
  SC=$(curl -s -b "$W/t.jar" "$B/api/practice" | json 'd.scenarios[0].id')
  curl -s -b "$W/t.jar" -H 'content-type: application/json' -d "{\"scenario_id\":\"$SC\"}" "$B/api/sessions" -o "$W/s1.json" -w '%{http_code}\n'   # 201
  curl -s -b "$W/t.jar" -H 'content-type: application/json' -d "{\"scenario_id\":\"$SC\"}" "$B/api/sessions" -w ' %{http_code}\n'                # {"error":{"code":"session_active",…}} 409
  ```

  (이미 진행 중인 세션이 있으면 첫 요청부터 409다. 그때는 화면에서 그 세션을 종료하고 다시 한다.)

## 3. SSE 순서와 401/403/404 (`curl`)

예비교사 세션의 턴(2단계에서 시작한 세션):

```sh
SID=$(json 'd.session.id' < "$W/s1.json")
curl -sN -b "$W/t.jar" -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"text":"분수의 크기를 어떻게 비교했는지 설명해 줄래?"}' "$B/api/sessions/$SID/turns" | tee "$W/t.sse" | grep '^event:'
```

기대값: `event:` 줄이 `classification`(분류가 나온 턴만) → `student` → (`trigger` → `mentor`, 멘토가 끼어든 턴만) → **`done`** 순서. 예비교사 세션에는 `state`가 **없다**. 각 `data:` 줄은 한 줄 JSON, `done`의 `data`는 `{"ended":false,"turns":[…]}`.

관리자 세션(대화 테스트와 같은 경로):

```sh
login a /api/admin/auth/login admin "$ADMIN_INITIAL_PASSWORD"         # 200
AID=$(curl -s -b "$W/a.jar" -H 'content-type: application/json' -H 'x-remath-realm: admin' -d "{\"scenario_id\":\"$SC\"}" "$B/api/sessions" | json 'd.session.id')
curl -sN -b "$W/a.jar" -H 'x-remath-realm: admin' -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"text":"왜 그렇게 생각했니?"}' "$B/api/sessions/$AID/turns" | grep -A1 '^event: state'
curl -s -b "$W/a.jar" -H 'x-remath-realm: admin' -X POST "$B/api/sessions/$AID/end" -o /dev/null -w '%{http_code}\n'   # 200
```

기대값: `event:` 순서는 위와 같고 **`done` 바로 앞에 `state`** 1개, 그 `data`에 `mis`·`counts`·`goal_reached`·`last_trigger`. 관리자 화면 대화 테스트의 내부 상태 패널과 같은 값.

접근 제어:

```sh
curl -s -b "$W/t.jar" -X POST "$B/api/sessions/$SID/end" -o /dev/null -w '%{http_code}\n'      # 200 (진행 중 세션 종료)
code -b "$W/t.jar" "$B/api/admin/users"                                                         # 401
U=$(curl -s -b "$W/a.jar" "$B/api/admin/scenarios" | json 'd.find(s=>s.slug==="seoyeon").id')   # 미할당 샘플
curl -s -b "$W/t.jar" -H 'content-type: application/json' -d "{\"scenario_id\":\"$U\"}" "$B/api/sessions" -w ' %{http_code}\n'   # {"error":{"code":"forbidden",…}} 403
read -rs OP   # 두 번째 예비교사의 비밀번호(8자 이상, 글자+숫자)
curl -s -b "$W/a.jar" -H 'content-type: application/json' -d "{\"nickname\":\"g3other\",\"password\":\"$OP\"}" "$B/api/admin/users" -o /dev/null -w '%{http_code}\n'   # 201
login o /api/auth/login g3other "$OP"                                                           # 200
code -b "$W/o.jar" "$B/api/sessions/$SID"                                                       # 404 (남의 세션은 존재도 알리지 않는다)
```

기대값: 예비교사 쿠키로 관리자 라우트 = **401**(관리자 쿠키가 없다), 미할당 시나리오 시작 = **403** `forbidden`, 남의 세션 = **404**.

## 4. 재배포: `deploy.sh` (옵션 없음)

```sh
while IFS= read -r l; do case $l in SUPABASE_*=*) export "$l";; esac; done < "$REMATH_ENV_FILE"   # 현재 프로젝트 = A
cp -p "$REMATH_ENV_FILE" "$W/env.4"
for t in $TABLES; do echo "$t $(q "select count(*) from $t")"; done > "$W/rows.4"
scripts/deploy.sh; echo "exit $?"
unset SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_DB_URL SUPABASE_ANON_KEY                        # 6·8단계가 셸의 A 값을 쓰지 않게
```

기대값:
- `== 1/6`(새 프로젝트) 줄이 **없다**, `db:migrate ok applied before: [0001, 0002, 0003, 0004], ran now: []`, 스모크 모두 `ok`, `deploy.sh: ok`, **`exit 0`**.

확인:

```sh
cmp "$W/env.4" "$REMATH_ENV_FILE" && echo same-env                    # same-env (같은 값으로 교체)
envv SUPABASE_URL                                                     # 여전히 ref A
q "select count(*) from schema_migrations"                            # 4
for t in $TABLES; do echo "$t $(q "select count(*) from $t")"; done | diff "$W/rows.4" - && echo same-rows
```

- 데이터가 그대로다: `same-rows`. 단 `audit_log`는 재배포 중 로그인이 없으면 같다(로그인 실패·쓰기를 하지 않는다).
- 대시보드 프로젝트 목록에 새 프로젝트가 **없다**.

## 5. 백업

```sh
dc exec server npm run backup
D=$(dc exec -T server date +%Y%m%d); F=backup/remath-$D.sqlite; ls -l "$F"
cp -p "$F" "$W/g3.sqlite"        # 6단계의 복구 끝 백업이 같은 이름을 덮어쓴다: 원본을 따로 둔다
```

기대값: `backup ok backup/remath-<D>.sqlite {"users":…,"audit_log":…}`, 종료코드 0. 1·4단계와 같은 날이면 같은 파일이 덮어써진다(mtime이 지금).

확인(이 단계부터 6단계 끝까지 화면에서 쓰기를 하지 않는다):

```sh
sqlite3 "$W/g3.sqlite" "select name from sqlite_master where type='table' order by 1"
for t in $TABLES; do echo "$t sqlite=$(sqlite3 "$W/g3.sqlite" "select count(*) from $t") pg=$(q "select count(*) from $t")"; done
sqlite3 "$W/g3.sqlite" "select count(*) from pragma_table_info('ai_settings') where name='key_ciphertext'"
```

- 테이블 **10개**: `ai_settings audit_log group_members group_scenarios groups scenario_translations scenarios sessions turns users`. `auth_sessions`·`schema_migrations`는 없다(O-5 (A)).
- 모든 줄에서 `sqlite=` = `pg=`.
- `key_ciphertext` 열 = `0`(없음).

복구 비교용 자료를 받아 둔다(관리자 쿠키 `a.jar`, 예비교사 `t.jar`는 3단계 로그인):

```sh
TID=$(curl -s -b "$W/a.jar" "$B/api/admin/users" | json "d.find(u=>u.nickname===\"$T\").id")
curl -s -b "$W/a.jar" "$B/api/admin/sessions.csv" -o "$W/all.5.csv"
curl -s -b "$W/a.jar" "$B/api/admin/sessions.csv?user_id=$TID" -o "$W/user.5.csv"
curl -s -b "$W/t.jar" "$B/api/sessions" -o "$W/hist.5.json"
curl -s -b "$W/t.jar" "$B/api/sessions/$SID" -o "$W/sid.5.json"
head -c 3 "$W/all.5.csv" | od -An -tx1                                 # ef bb bf (UTF-8 BOM)
```

## 6. 복구: `restore.sh`

```sh
scripts/restore.sh "$W/g3.sqlite"; echo "exit $?"
```

(`REMATH_ENV_FILE`와 Management 변수 4개는 셸에 있다. `ADMIN_INITIAL_PASSWORD`는 쓰지 않는다.)

기대값: 새 프로젝트 B 생성 → 마이그레이션 → 백업 적재 → 스모크(기대 행 수 = 백업 행 수, 모두 `ok`) → 전환·`/healthz` 200 → 백업, **`exit 0`**.

확인:

```sh
envv SUPABASE_URL                                                     # https://<ref B>.supabase.co, ref A 와 다르다
q "select count(*) from schema_migrations"                            # 4
for t in $TABLES; do echo "$t sqlite=$(sqlite3 "$W/g3.sqlite" "select count(*) from $t") pg=$(q "select count(*) from $t")"; done   # audit_log 말고 전부 같다
q "select count(*) from auth_sessions"                                # 0
code -b "$W/t.jar" "$B/api/auth/me"                                   # 401 (로그인은 복구되지 않는다)
login t /api/auth/login "$T" "$TP"                                    # 200 — 같은 비밀번호
login a /api/admin/auth/login admin "$ADMIN_INITIAL_PASSWORD"         # 200
curl -s -b "$W/t.jar" "$B/api/sessions" | cmp - "$W/hist.5.json" && echo same-history
curl -s -b "$W/t.jar" "$B/api/sessions/$SID" | cmp - "$W/sid.5.json" && echo same-report
curl -s -b "$W/a.jar" "$B/api/admin/sessions.csv" | cmp - "$W/all.5.csv" && echo same-csv
curl -s -b "$W/a.jar" "$B/api/admin/sessions.csv?user_id=$TID" | cmp - "$W/user.5.csv" && echo same-user-csv
```

- 행 수: 백업과 같다. `audit_log`만 위 두 로그인 등으로 늘 수 있다(복구 직후 스모크 시점에는 같았다).
- `same-history`, `same-report`, `same-csv`, `same-user-csv` 넷 다 출력(= **바이트 동일**). 브라우저에서도 예비교사의 내 기록·리포트가 같다.
- 대시보드에 프로젝트 **A가 그대로 남아 있다**(B와 함께 활성).

## 7. 관리자 비밀번호 초기화

```sh
dc exec server npm run admin:reset-password; echo "exit $?"
```

프롬프트 `New admin password:`·`Repeat new admin password:`에 같은 새 비밀번호(에코 없음). 그다음 셸에서 `read -rs NP`로 그 비밀번호를 받아 둔다.

기대값: `admin password reset; every admin login has ended`, **`exit 0`**.

확인:

```sh
code -b "$W/a.jar" "$B/api/admin/auth/me"                             # 401 (기존 관리자 로그인 끝)
login a2 /api/admin/auth/login admin "$ADMIN_INITIAL_PASSWORD"        # 401 (이전 비밀번호)
login a /api/admin/auth/login admin "$NP"                             # 200 (새 비밀번호)
code -b "$W/t.jar" "$B/api/auth/me"                                   # 200 (예비교사 로그인은 그대로)
q "select actor_id is null, target = (select id::text from users where role='admin'), meta->>'host' from audit_log where action='admin.password_reset'"
```

- 브라우저의 기존 관리자 탭도 다음 요청에서 401 → 로그인 화면.
- SQL은 **1행** `t|t|<컨테이너 호스트명>`(actor null, target = 관리자 id, `meta.host`; Docker 기본 호스트명은 컨테이너 id 앞 12자: `dc exec -T server hostname`).

## 8. 실패 경로: anon 키 자리에 service key → `deploy.sh --new`

먼저 슬롯을 비운다: 프로젝트 **A를 일시 중지**(위 슬롯 계획). 그다음:

```sh
cp -p "$REMATH_ENV_FILE" "$W/env.8"
docker inspect -f '{{.State.StartedAt}}' remath > "$W/started.8"
DEPLOY_NEW_FAULT=anon_as_service scripts/deploy.sh --new; echo "exit $?"
```

기대값:
- 1~3단계 통과, 4단계 스모크에 `FAIL anon denied scenarios.internal: HTTP 200 code -`(나머지 줄은 `ok`), `db:smoke failed: smoke FAIL`, `deploy.sh: new Supabase project <ref C> is left in place (not switched to); …`, **`exit` ≠ 0**. `== 5/6` 줄이 없다.

확인:

```sh
cmp "$W/env.8" "$REMATH_ENV_FILE" && echo env-untouched                # env-untouched
envv SUPABASE_URL                                                     # 여전히 ref B
docker inspect -f '{{.State.StartedAt}}' remath | cmp - "$W/started.8" && echo container-untouched
curl -s -w ' %{http_code}\n' "$B/healthz"                             # {"ok":true} 200
code -b "$W/t.jar" "$B/api/auth/me"                                   # 200 — 서비스는 B 그대로
```

- 대시보드에 프로젝트 C가 생겨 있다(자동 삭제 없음). 사람이 지운다.

## 정리

```sh
rm -rf "$W"; unset TP OP NP ADMIN_INITIAL_PASSWORD SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
```

`$W`에는 쿠키(로그인 토큰)와 env 파일 사본(service key·DB 비밀번호)이 있었다. 프로젝트 A·C는 결과를 기록한 뒤 대시보드에서 지운다. 스테이징 B와 `backup/`은 남긴다.
