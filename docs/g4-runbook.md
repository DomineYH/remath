# G4 수용 런북 (실서버) — 초안

#53 Q15 "실서버 배포 → 키 등록 → 그룹·사용자 → 예비교사 세션 종료 → CSV"를 실행하는 순서표다(G3 런북과 같은 형식). 각 단계는 **명령 → 기대값 → 확인**이다. 기대값과 다르면 거기서 멈추고 출력과 함께 기록한다. 명령·변수·실패 시 상태의 설명은 README "운영"(특히 "실서버(HTTPS, Caddy)"). 끝에 사람이 서명한다.

## 0. 사전조건 (#61 산출물)

- **호스트**: Linux, Docker 데몬 + Docker Compose v2.30 이상, Node 24·npm, `psql`(postgresql-client), `curl`, `sqlite3`, Caddy. 저장소는 검수할 커밋으로 체크아웃하고 루트에서 실행한다.
- **도메인·DNS·Caddy**: `<domain>`의 A 레코드 → 이 호스트. README "실서버"의 Caddyfile을 `/etc/caddy/Caddyfile`에 두고 `sudo systemctl reload caddy`.

  ```sh
  curl -sS -o /dev/null -w '%{http_code}\n' https://<domain>/healthz     # 502 (TLS 성공, 아직 컨테이너 없음). TLS 오류면 멈춘다
  ```

- **공급자 키 3종**(OpenAI·Anthropic·Gemini): 발급만 해 둔다. 2단계에서 관리자 화면에 붙여 넣는다. 파일·셸 변수·이슈에 적지 않는다.
- **Supabase 슬롯**: 일시 중지된 스테이징 A가 삭제되어 있고, 조직의 **활성** 프로젝트가 1개 이하(무료 플랜 한도 2개). 아니면 1단계가 HTTP 400으로 실패하고 아무것도 만들지 않는다.
- 이미지: `npm ci && docker build -t remath:latest .` → 종료코드 0.
- 런타임 env 파일(실 공급자, HTTPS라 `COOKIE_SECURE` 없음):

  ```sh
  umask 077; printf 'MOCK_LLM=0\nKEY_VAULT_SECRET=%s\n' "$(openssl rand -base64 32)" > /abs/path/remath-server.env
  ```

  이 파일은 백업에 들어가지 않는다. `KEY_VAULT_SECRET`을 잃거나 바꾸면 세 역할의 키를 다시 등록한다.
- 운영자 셸:

  ```sh
  export REMATH_ENV_FILE=/abs/path/remath-server.env
  export SUPABASE_ACCESS_TOKEN=<토큰> SUPABASE_ORG_ID=<조직 slug> SUPABASE_REGION=<리전> SUPABASE_DB_PASSWORD=<새 DB 비밀번호>
  read -rs ADMIN_INITIAL_PASSWORD && export ADMIN_INITIAL_PASSWORD
  ```

- 도우미(같은 셸에서 끝까지 쓴다). `W`에는 쿠키·CSV가 생기므로 마지막에 지운다.

  ```sh
  W=$(mktemp -d)                          # 700
  B=https://<domain>                      # Caddy 경유
  dc() { docker compose -f deploy/compose.yaml "$@"; }
  envv() { grep "^$1=" "$REMATH_ENV_FILE" | cut -d= -f2-; }       # 런타임 env 파일의 값 (source 하지 않는다)
  q() { psql "$(envv SUPABASE_DB_URL)" -XAt -c "$1"; }             # 지금 서비스 중인 DB 에 SQL
  code() { curl -s -o /dev/null -w '%{http_code}\n' "$@"; }
  json() { node -p "const d=JSON.parse(fs.readFileSync(0)); $1"; }  # 표준입력 JSON 에서 값 하나
  login() { curl -s -c "$W/$1.jar" -H 'content-type: application/json' -d "{\"nickname\":\"$3\",\"password\":\"$4\"}" "$B$2" -o /dev/null -w '%{http_code}\n'; }
  ```

## 1. 새 서버: `deploy.sh --new --with-samples` (`MOCK_LLM=0`)

```sh
scripts/deploy.sh --new --with-samples; echo "exit $?"
```

기대값:
- 사전 점검 통과(`KEY_VAULT_SECRET` 검사 포함, 통과하면 출력 없음). 실패하면 `KEY_VAULT_SECRET … not set`/`not 32 bytes` + `openssl rand -base64 32` 안내, 프로젝트를 만들지 않는다.
- `== 1/6` … `== 6/6` 순서, 스모크 줄이 모두 `ok`(관리자 1, `ai_settings` 3, 샘플 5, 번역 10, anon 거부 `42501`).
- `deploy.sh: switched (…/healthz 200, new DB answers)`, `backup ok …`, `deploy.sh: ok`, **`exit 0`**.

확인:

```sh
envv SUPABASE_URL                                   # https://<ref>.supabase.co — ref 를 적어 둔다
dc logs server | grep -c '"msg":"llm: live"'        # 1 이상
dc logs server | grep -c '"msg":"llm: mock"'        # 0
curl -s -w ' %{http_code}\n' "$B/healthz"           # {"ok":true} 200 (Caddy·TLS 경유)
q "select count(*) from ai_settings where key_ciphertext is not null"   # 0 (아직 키 없음)
```

## 2. 관리자 로그인·키 3종 등록

`$B/admin`을 새 브라우저 프로필로 연다. ID `admin`, 비밀번호 = `ADMIN_INITIAL_PASSWORD`. AI 설정에서 세 역할(학생·멘토·분석)에 API 키 "이 챗봇 전용 키"로 공급자 키를 하나씩(3종이 한 번씩) 붙여 넣고 모델·effort를 골라 역할마다 저장한다.

기대값:
- 저장마다 "설정을 저장했습니다." 저장은 그 키로 공급자의 모델 목록(`listModels`)을 1회 불러 통과해야만 된다: 공급자가 거절하면 저장되지 않고 오류(502 `provider_rejected`)가 뜬다 — 그 키는 다시 확인한다.
- 다시 열면 역할마다 마스킹된 키(접두어 + 끝 4자)·모델·effort가 보인다. 키 원문은 다시 보이지 않는다.

확인:

```sh
login a /api/admin/auth/login admin "$ADMIN_INITIAL_PASSWORD"                                     # 200
awk -F'\t' '$6=="remath_admin"{print $4}' "$W/a.jar"                                               # TRUE (Secure 쿠키)
curl -s -b "$W/a.jar" "$B/api/admin/ai" | json 'Object.values(d).map(r=>[r.role,r.key_source,r.provider,r.key_masked,r.model,r.effort].join(" ")).join("\n")'
q "select role, provider, key_ciphertext is not null from ai_settings order by 1"
dc logs server | grep -c 'ai key rejected by provider'                                             # 0 (마지막 저장 시도까지 거절 없음이면)
```

- `/api/admin/ai` 3줄: 모두 `own`, 공급자 `openai`·`anthropic`·`gemini`가 한 번씩, `key_masked`가 비어 있지 않다.
- SQL 3행 모두 끝이 `t`(암호문 저장). 앞서 거절된 시도가 있었다면 로그 줄 수 = 그 시도 수.
- (선택) 거절 경로: 가짜 키로 저장을 시도하면 502 `provider_rejected`이고 설정은 그대로다.

  ```sh
  M=$(curl -s -b "$W/a.jar" "$B/api/admin/ai" | json 'd.analysis.model')
  curl -s -b "$W/a.jar" -X PUT -H 'content-type: application/json' -d "{\"key_source\":\"own\",\"api_key\":\"sk-ant-g4-invalid-0000\",\"model\":\"$M\",\"effort\":null}" "$B/api/admin/ai/analysis" -w ' %{http_code}\n'   # {"error":{"code":"provider_rejected",…}} 502
  q "select provider, key_ciphertext is not null from ai_settings where role='analysis'"            # 그대로
  ```

## 3. 샘플 시나리오 게시·그룹·예비교사 1명

브라우저(관리자):
- 시나리오: 샘플 5개가 "게시"다(1단계 `--with-samples`가 게시·컴파일본까지 넣는다). 그중 하나(예: Seoyeon)를 고른다.
- 사용자 → "＋ 사용자 추가"(닉네임 + 비밀번호). 셸에 적어 둔다: `T=<닉네임>; read -rs TP`.
- 그룹 → "＋ 그룹 만들기": 그 예비교사 + 고른 샘플 시나리오.

확인:

```sh
q "select slug, status from scenarios order by 1"                                                 # 5행 모두 published
login t /api/auth/login "$T" "$TP"                                                                 # 200
awk -F'\t' '$6=="remath_teacher"{print $4}' "$W/t.jar"                                             # TRUE
curl -s -b "$W/t.jar" "$B/api/practice" | json 'd.scenarios.map(s=>s.slug).join(" ")'             # 그룹에 넣은 슬러그 1개
```

## 4. 예비교사 세션을 끝까지

**다른 브라우저 프로필**에서 `$B/`, 3단계의 예비교사로 로그인 → 학생 선택 → 대화. 도달점에 이르거나(멘토 도달점 개입 → 리포트) "END SESSION"/"세션 종료"로 끝낸다.

기대값:
- 학생 응답이 실모델로 글자가 늘어나며 표시된다(목 문구가 아니다). 분류 토글·멘토 개입이 목 모드와 같은 자리에 나온다.
- 종료 후 리포트(레버리지 막대·판정 줄). "내 기록" → "보기"가 같은 리포트.

확인:

```sh
q "select s.id, s.ended_at is not null, s.goal_reached, s.report is not null, (select count(*) from turns t where t.session_id = s.id) from sessions s join users u on u.id = s.user_id where u.nickname = '$T'"
N=<위 결과의 마지막 칸>
dc logs server | grep -c '"level":50'                                                              # 0 (서버 오류 없음)
```

- 1행: `<id>|t|<t 또는 f>|t|<N>`(종료됨, 도달 여부, 리포트 있음, 발화 수). 도달점으로 끝났으면 `goal_reached` = `t`.

## 5. 관리자 CSV 다운로드·행 수

관리자 브라우저 → 대화 기록 → 그 예비교사로 거른 뒤 "CSV 내려받기 (n건)". 셸에서도 같은 파일을 받는다:

```sh
TID=$(curl -s -b "$W/a.jar" "$B/api/admin/users" | json "d.find(u=>u.nickname===\"$T\").id")
curl -s -b "$W/a.jar" "$B/api/admin/sessions.csv?user_id=$TID" -o "$W/g4.csv"
head -c 3 "$W/g4.csv" | od -An -tx1                                   # ef bb bf (UTF-8 BOM)
head -1 "$W/g4.csv" | tail -c +4                                      # session_id,started_at,nickname,scenario,lang,seq,speaker,text,leverage,object,trigger
tr -cd '\r' < "$W/g4.csv" | wc -c                                     # = N (1행 = 1발화, 줄 구분 CRLF, 끝 줄바꿈 없음)
cmp "$W/g4.csv" ~/Downloads/<내려받은 파일> && echo same-csv          # 브라우저 파일과 바이트 동일
```

기대값: 데이터 행 수 = 4단계의 `N`, `same-csv`.

## 6. 백업에 `key_ciphertext` 없음

```sh
dc exec server npm run backup
D=$(dc exec -T server date +%Y%m%d); F=backup/remath-$D.sqlite; ls -l "$F"
```

기대값: `backup ok backup/remath-<D>.sqlite {"users":…,"ai_settings":3,…}`, 종료코드 0. `D`는 컨테이너 시각 기준 날짜(기본 UTC).

확인:

```sh
sqlite3 "$F" "select count(*) from pragma_table_info('ai_settings') where name='key_ciphertext'"   # 0 (열 없음)
sqlite3 "$F" "select role, provider, key_masked is not null from ai_settings order by 1"           # 3행, 공급자·마스킹만
q "select count(*) from ai_settings where key_ciphertext is not null"                              # 3 (DB 에는 있다)
grep -cF "$(envv KEY_VAULT_SECRET)" "$F"                                                            # 0 (비밀도 없다)
```

- 백업에는 키도 비밀도 없다: 이 파일로 복구하면(README `restore.sh`) 관리자 AI 설정에서 세 키를 다시 등록한다.
- 백업에는 비밀번호 해시가 있다: 파일 권한·보관 위치에 주의한다.

## 정리

```sh
rm -rf "$W"; unset TP ADMIN_INITIAL_PASSWORD SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD M N
```

`$W`에는 쿠키(로그인 토큰)와 CSV(발화 원문)가 있었다. 브라우저가 내려받은 CSV도 지운다. 실서버 프로젝트와 `backup/`은 남긴다.

## 서명

| 단계 | 결과(통과/실패, 메모) |
|---|---|
| 0 사전조건 | |
| 1 `deploy.sh --new` | |
| 2 키 3종 | |
| 3 시나리오·그룹·예비교사 | |
| 4 세션 종료 | |
| 5 CSV | |
| 6 백업 | |

검수자: ________ 날짜: ________ 커밋: ________
