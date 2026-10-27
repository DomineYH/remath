# API 계약 초안 — zod 공유 스키마 (프로토타입, 티켓 10)

파일: `src/schemas.ts`(zod 스키마), `src/routes.ts`(엔드포인트 표 — 서버 라우트 등록과 클라이언트 인터페이스가 같은 표를 본다), `check.ts`(점검). 저장소에서는 `shared/src/api/`(가정 확정: 공유 패키지 이름은 `shared/`, 티켓 12 와 동일). 점검: zod@4 를 아무 데나 설치하고 `ln -s <폴더>/node_modules prototypes/api-contract/node_modules && node prototypes/api-contract/check.ts`.

근거: PRD 3·4·9·11절, 지도 C6~C10·C13·C15, ADR-0002(판정)·ADR-0003(노출면), 티켓 6·11·12·14 가 이 티켓에 넘긴 관찰, 목업(`autoChecks`, `PROV`, 화면 동작).

## 1. 형식 결정

| # | 결정 | 한 줄 근거 |
|---|---|---|
| 1 | **zod 스키마 + 라우트 표**(OpenAPI 아님) | 서버는 `fastify-type-provider-zod`, 클라이언트는 같은 타입. OpenAPI 가 필요하면 zod 에서 생성 |
| 2 | **JSON 키는 DB 와 같은 snake_case** | `scenarios_public` 뷰 컬럼 집합이 곧 `ScenarioPublic`(ADR-0003). 매핑 계층 없음. 목업의 `desc`는 `description` |
| 3 | 예비교사 노출면은 **별도 타입**(`ScenarioPublic`·`SessionRow`·`Turn`·`SessionReport`)이고 `internal`·`compiled_prompt`·`progress`·`counts` 키가 **타입에 아예 없다**. `check.ts` 1번이 라우트 표를 걸어 자동 확인 | ADR-0003 Consequences |
| 4 | **페이지네이션 없음**, 목록은 최신순 전체 | 한 반 30명·개발자 1명. 필요해지면 `?limit`·`?before` 추가 |
| 5 | 오류 = `{error:{code,message,details?}}` 하나, HTTP 상태는 code 가 정한다(4절) | 클라이언트 문구는 code 로 사전에서 고른다 |

## 2. 인증·쿠키

- 두 실(realm)에 **쿠키 2개**: `remath_teacher`(7일), `remath_admin`(12시간). 둘 다 `httpOnly; Secure; SameSite=Lax; Path=/`. 값은 불투명 토큰(32바이트 랜덤), 서버는 sha256 만 저장(`auth_sessions`, C9). 이름이 다르므로 한 브라우저에서 두 로그인이 공존한다(관리자가 다른 탭으로 예비교사 화면을 볼 수 있음).
- `/api/admin/*` 은 관리자 쿠키만, `/api/auth/*`·`/api/practice`·`/api/sessions`(목록)은 예비교사 쿠키만. `/api/sessions/current`·`POST /api/sessions`·`/api/sessions/:id/*` 는 **둘 중 하나 + 세션 소유자 검사** — 관리자 대화 테스트가 같은 경로를 쓴다(별도 엔드포인트 없음). 관리자는 초안 시나리오로도 시작할 수 있고, 예비교사는 `teacher_scenarios(user_id)` 에 있는 것만.
- 로그인 실패는 두 실 모두 401 `invalid_credentials`(아이디/비밀번호 구분 없음). 5회부터 닉네임 단위 1분 지연 → 429 `too_many_attempts` + `details.retry_after`.
- CSRF: SameSite=Lax + 변경 요청은 `Content-Type: application/json` 필수(Fastify 기본이 폼 인코딩을 거부). 별도 토큰 없음.
- 비밀번호 변경·관리자의 재설정·CLI 초기화는 그 사용자의 **로그인을 모두 종료**한다(현재 요청의 로그인만 예외 — 본인 변경).

## 3. 엔드포인트 (37개, `src/routes.ts` 가 원본)

| 영역 | 경로 | 요지 |
|---|---|---|
| 인증 | `POST /api/auth/signup`·`login`, `POST logout`, `GET me`, `PUT password` | 계정 만들기는 즉시 로그인. 관리자는 `/api/admin/auth/*` 같은 4종 |
| 학생 선택 | `GET /api/practice` → `{groups, scenarios[+group_ids]}` | `groups` 0개 = "그룹 없음", 있는데 `scenarios` 0개 = "할당 없음". 분석 여부는 `classification.leverage.length` 로 클라이언트가 유도 |
| 연습 세션 | `POST /api/sessions {scenario_id}` → 201 `SessionDetail` | 인사 발화(seq 1, student)가 이미 들어 있다. 진행 중 세션이 있으면 409 `session_active` + `details.session_id` — "다른 학생"은 먼저 `end` |
| | `GET /api/sessions/current` → `SessionDetail \| null` | C15 새로고침 복구 |
| | `POST /api/sessions/:id/turns {text}` → **SSE** | 5절. 409 `turn_in_progress`(C8, `turn_started_at` 기준)·`session_ended`·`turn_limit_reached`(기본 40, 서버 환경변수) |
| | `POST /api/sessions/:id/end` → `SessionReport \| null` | 종료 버튼. `END SESSION` 발화와 **같은 처리·같은 객체**(티켓 14) |
| | `GET /api/sessions` → `SessionRow[]`, `GET /api/sessions/:id` → `SessionDetail` | 내 기록. `report` 는 저장본 |
| 시나리오 | `GET /api/admin/scenarios` → `ScenarioSummary[]` | 목록 카드 |
| | `POST`·`GET /:id`·`PUT /:id` ↔ `ScenarioInput`/`ScenarioAdmin` | 두 언어판을 항상 함께 저장(SCN-2). **PUT 은 항상 `status=draft`, `compiled_prompt=null`** — 게시본과 저장본이 어긋나지 않게(DB check 제약과 일치). 게시 내리기 = 초안 저장 |
| | `DELETE /:id` | 기록(연습 세션)이 있으면 409 `scenario_has_sessions` + `details.session_count`. 보관 상태 없음 — 내리려면 초안으로 |
| | `GET /:id/review` → `ReviewResult` | 자동 점검 c1~c6(목업) + **c7 두 판 템플릿 구조 일치**(티켓 9). 관리자 확인 m1~m4 는 저장하지 않는다 |
| | `POST /:id/publish {confirmed:[m1..m4]}` | 자동 fail 이 있거나 확인 4개 미만이면 422 `review_failed` + `details: ReviewResult`. 통과 시 `compileScenario` 로 컴파일·`published`·`audit_log` |
| | `GET /:id/prompt` → `Compiled {student, analysis\|null, mentor}` | 저장본을 활성 `lang` 으로 컴파일한 전문("프롬프트 보기"). 위자드 7단계 미리보기(미저장 폼)는 클라이언트가 같은 `compileScenario` 로 로컬 컴파일 |
| 사용자 | `GET /api/admin/users` → `UserRow[]`, `POST {nickname,password}`, `PUT /:id/password`, `DELETE /:id` | 삭제는 cascade(USR-1), 확인창 건수는 `session_count` |
| 그룹 | `GET`·`POST`·`PUT /:id`·`DELETE /:id` ↔ `GroupInput {name, member_ids, scenario_ids}` | PUT 은 전체 치환 |
| 대화 기록 | `GET /api/admin/sessions?user_id&scenario_id` → `SessionRow[]`, `GET /:id` → `SessionDetail`, `GET /api/admin/sessions.csv?…` | CSV 는 같은 필터, UTF-8 BOM, 열 = C13. 사용자·시나리오 카드의 "CSV" 버튼도 이 경로 |
| AI 설정 | `GET /api/admin/ai` → `AiSettings`, `PUT /api/admin/ai/:role` ← `AiRoleInput` | 응답은 `key_masked`·`key_added_at`·`provider`·`model`·`effort` 만(AI-3). 구현은 3단계. 모델 목록 `GET /api/admin/ai/providers` 는 티켓 18 |

이모지 프리셋은 엔드포인트가 아니라 `shared/` 상수(시드 `emoji_presets.json` 과 같은 파일). 위자드 "예시로 채우기"는 fog 그대로.

## 4. 오류 코드 ↔ HTTP 상태

| 상태 | code |
|---|---|
| 400 | `validation_failed`(details = zod issues), `invalid_effort` |
| 401 | `unauthorized`(쿠키 없음·만료), `invalid_credentials` |
| 403 | `forbidden`(실 불일치, 남의 세션, 미할당 시나리오) |
| 404 | `not_found` |
| 409 | `nickname_taken`, `session_active`, `session_ended`, `turn_in_progress`, `scenario_has_sessions` |
| 422 | `review_failed`(details = ReviewResult), `turn_limit_reached` |
| 429 | `too_many_attempts`(details.retry_after 초) |
| 502 | `provider_rejected`(AI 설정 저장 시 공급자 400/401), `provider_unavailable`(SSE `error` 로도) |

## 5. 턴 SSE (`POST /api/sessions/:id/turns`, `text/event-stream`)

- 프레임 `event: <type>\ndata: <json>\n\n`. 응답이 POST 라 `EventSource` 는 못 쓰고 `fetch` + 스트림 파서(클라이언트 `api/` 모듈 하나). `id`·`retry` 없음, 재접속 없음 — 끊기면 `GET /api/sessions/:id` 로 복구.
- 순서 = 파이프라인 `runTurn` 그대로: `classification`(분류 기준 있을 때만) → `student`… → (`trigger` → `mentor`…) → `done`. 어느 단계에서든 실패하면 `error` 후 종료.
- **`student`·`mentor` 는 `{text, final}`**: `final:false` 청크를 0회 이상 흘린 뒤 **전문 하나를 `final:true`** 로 낸다(PRD 11절 첫 글자 3초 목표·C7 이벤트 이름 유지 둘 다). 클라이언트는 청크를 이어 붙이다 final 로 치환. MOCK 은 final 하나만.
- `done` 두 갈래(티켓 14): `{ended:false, turns: Turn[]}` — 이번 한 턴에 기록된 발화(예비교사·학생·멘토, seq 포함)로 클라이언트가 로그를 정본으로 맞춘다 / `{ended:true, report: SessionReport|null}` — `END SESSION` 발화는 기록하지 않는다.
- **원자성**: `error` 가 나가면 이 턴의 발화는 하나도 기록되지 않고 `turn_started_at` 이 지워진다. 클라이언트는 같은 문장을 다시 보낼 수 있다(화면 문구·자동 재시도 여부는 fog "LLM 호출 실패·재시도 시 화면 동작").
- 관리자 전용 `state` 이벤트의 자리는 비워 두었다(티켓 15 가 정함). 예비교사 유니온에는 없다 — `check.ts` 3번이 거부를 확인.

## 6. 채택한 추천안 (사용자 일괄 승인) · 가정

1. **zod + 라우트 표, `shared/`** — 티켓 본문 추천. 공유 패키지 이름 `shared/` 는 티켓 12 의 가정을 이 티켓이 **확정**한다(C3 의 워크스페이스에 `shared/` 추가).
2. **snake_case** — 뷰 컬럼 = 응답 타입이라는 ADR-0003 을 글자 그대로 지키고 서버 매핑을 없앤다.
3. **관리자 대화 테스트는 같은 세션 경로** — 실 2개를 허용하는 핸들러 하나. 내부 상태만 티켓 15 의 이벤트로 추가.
4. **종료 버튼 = `POST …/end`, 발화 `END SESSION` 과 같은 함수** — 리포트 형태 하나(티켓 14).
5. **PUT 은 항상 draft** — "편집 중인 게시본" 상태를 만들지 않는다. 재게시가 곧 재컴파일(C11).
6. **시나리오 삭제는 기록이 있으면 409**(티켓 11 의 가정 확정, `on delete restrict` 유지) — 예비교사 내 기록을 지우지 않는다. 내리기는 초안 저장으로 충분.
7. **진행 중 세션은 사용자당 1개**(409 `session_active`) — C8·C15 의 "현재 세션" 개념과 일치. "다른 학생"은 종료 후 이동.
8. **student/mentor 청크 + final** — 스트리밍 목표와 C7 이벤트 집합을 둘 다 만족하는 최소 형태.
9. **관리자 확인 m1~m4 는 게시 요청 본문** — 저장할 이유가 없고 PRD 는 "통과 시에만 게시"만 요구. `audit_log` 의 `scenario.publish` meta 에 남긴다.
10. **페이지네이션 없음**, **CSRF 토큰 없음**(SameSite=Lax + JSON 강제).

- **가정: 턴 상한 초과는 422 `turn_limit_reached`** — 화면 동작은 fog. 
- **가정: `too_many_attempts` 는 429** — PRD 는 "1분 지연"만 말한다. 지연 대신 즉시 429 가 구현이 단순하고 UX 가 명확하다(지연은 서버 자원을 묶는다).

## 7. 알려진 한계 · 다른 티켓으로

- 관리자 `state` 이벤트(티켓 15), `GET /api/admin/ai/providers` 응답(티켓 18), 클라이언트 인터페이스·목 저장(티켓 13)은 이 표를 전제로 한다.
- `review` 의 c1~c6 판정 규칙은 목업 `autoChecks` 이식(서버 순수 함수, `shared/`), 이 초안은 결과 형태만 정했다.
- `AiRoleInput` 의 키 검증(`listModels`)·마스킹 규칙은 3단계. `providers.json` 검증(`invalid_effort`)은 티켓 18.
- `turn_started_at` 이 서버 중단으로 남는 경우의 해제 규칙은 fog 그대로(이 계약은 409 만 정한다).
