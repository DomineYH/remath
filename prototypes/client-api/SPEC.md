# 클라이언트 API 경계·목 구현 계약 초안 (프로토타입, 티켓 13)

파일: `src/api/types.ts`(인터페이스 `Api` + 메서드↔라우트 표 `API_ROUTES` + `ApiError`), `src/api/http.ts`(HTTP 구현 + SSE 파서), `src/api/mock/store.ts`(저장소·시드), `src/api/mock/index.ts`(목 구현), `src/api/index.ts`(교체 지점 `createApi`), `check.ts`(점검). 저장소에서는 `client/src/api/` 그대로. 이 브랜치는 티켓 10(`prototypes/api-contract`)·12(`prototypes/llm-adapter`)의 파일을 그대로 가져와 import 한다(복사·수정 없음).

점검: zod@4 를 아무 데나 설치하고 저장소 루트에 `ln -s <그 폴더>/node_modules node_modules`(커밋하지 않음) 뒤 `node prototypes/client-api/check.ts` (Node 24).

근거: 지도 C6(인터페이스 1 + 구현 2, `VITE_MOCK_API`)·C7·C8·C13·C15, 티켓 10 SPEC(라우트 표·오류·SSE), 티켓 12 SPEC(`runTurn`·`mockProvider` 를 브라우저에서 그대로), 티켓 9·11·14 가 이 티켓에 넘긴 관찰, 목업(`localStorage` 키·SEED·`autoChecks`).

## 1. 결정

| # | 결정 | 한 줄 근거 |
|---|---|---|
| 1 | **인터페이스 = 라우트 표 37행과 1:1 메서드 37개**. 이름은 경로에서 유도(`startSession`·`sendTurn`·`listAdminSessions`…), 타입은 공유 zod 스키마의 `z.infer`, 키는 snake_case 그대로 | 표가 한 곳(`routes.ts`)이라 서버·클라이언트가 어긋날 자리가 없다. `API_ROUTES` 가 대응을 적고 `check.ts` 1번이 집합 일치를 확인 |
| 2 | 인자 규칙 하나: 경로에 `:param` 이 있으면 첫 인자, body/query 가 있으면 그다음 인자. `sendTurn` 만 `AsyncIterable<SseEvent>` 를 **동기로** 돌려주고 나머지는 Promise | HTTP 구현이 이 규칙 + 표만으로 전 메서드를 생성한다(30줄) |
| 3 | **realm 은 인스턴스 속성**: `createApi('teacher')`·`createApi('admin')` 둘을 두고 화면이 하나를 고른다. `any` 라우트(세션 경로 5개)에서 HTTP 는 `X-Remath-Realm` 헤더로 어느 쿠키로 행동할지 알리고, 목은 그 실의 로그인을 쓴다 | 한 브라우저에 쿠키 2개가 공존하므로(티켓 10) 서버가 "누구의 세션인가"를 요청마다 알아야 한다. 가정 ↓ |
| 4 | 오류는 `ApiError {status, body:{error:{code,message,details}}}` 하나. 두 구현 모두 throw. **스트림 시작 전** 오류(404·409·422·400)는 `sendTurn` 의 첫 `next()` 에서 throw, 시작 후는 `error` 이벤트 | 화면은 code 로 문구를 고른다(티켓 10). 턴 시작 실패와 도중 실패를 한 자리에서 구분 |
| 5 | **목 저장 = 메모리 객체 하나 + `localStorage` 키 하나 `remath.mock.v1`**(users·groups·scenarios·sessions·turns·login·ai). 목업 키(`remath.scen.v3` 등)는 쓰지 않는다. 초기화 = 키 삭제 | 모양이 서버 테이블(티켓 11)과 같아야 2단계에 화면이 안 바뀐다. 목업 데이터와 섞이면 깨진다 |
| 6 | **초기 데이터 = 목업 SEED 그대로**(사용자 7·관리자·그룹 4·시나리오 4). 저장소에서는 `db/seed/samples/*.json`(C12) 을 서버 시드와 클라이언트 목이 **같은 파일**로 import 한다. 기록(세션)은 미리 넣지 않고 앱 시작 시 `seedSessions()` 가 비어 있을 때 목업 `SEED_LOGS` 질문을 같은 파이프라인으로 재생한다(목업 `simulate` 와 같은 방식) | 기록을 손으로 적으면 규칙 엔진과 어긋난다. 재생이면 항상 일치 |
| 7 | **턴 스트리밍 = 공유 `runTurn` + `mockProvider` 를 브라우저에서 그대로**. 목은 `TurnEvent` → `SseEvent` 로만 바꾼다: `student`/`mentor` 는 `final:true` 하나, `done` 은 이번 턴 발화에 seq 를 매겨 넣음, `trigger` 는 멘토 행에만(티켓 11). 예외는 `error` 이벤트 + 이 턴 발화 미기록 | 서버의 SSE 핸들러가 할 변환과 같다. LLM 흉내를 따로 두지 않는다 |
| 8 | **교체 지점은 `createApi` 의 한 줄** `env.VITE_MOCK_API === '1' ? mock : http`. 화면 코드는 `Api`·`ApiError` 타입만 import, `http.ts`·`mock/` 직접 import 는 lint 로 금지 | C6 "그 외 분기 금지" |
| 9 | 목도 **본문·쿼리를 라우트 표의 zod 로 검증**해 400 `validation_failed` 를 낸다(메서드 밖에서 한 번 감쌈) | 1단계 화면이 서버와 같은 오류를 본다 |
| 10 | 위자드 7단계 **미리보기는 두 모드 모두 클라이언트 컴파일**(`prompts/` 패키지의 `compileScenario`, 템플릿은 raw 문자열 번들). 서버는 게시 시에만 컴파일해 저장하고 `GET /:id/prompt` 는 저장본 컴파일(목도 같은 함수를 주입받아 씀) | 티켓 9 관찰의 추천. 미저장 폼을 서버에 보낼 이유가 없다 |
| 11 | CSV 는 `Blob` 으로 돌려준다(`downloadSessionsCsv → Promise<Blob>`) | `Response.text()` 는 BOM 을 벗긴다(C13 BOM 보존). `<a download>` 에 그대로 |
| 12 | 이모지 프리셋·검수 자동 점검 c1~c7·`compileScenario` 는 `shared/`·`prompts/` 순수 함수로 목과 서버가 공용. 프로토타입의 `review()` 는 목업 `autoChecks` 를 그대로 이식한 자리 표시 | 티켓 10 7절 |

## 2. 인터페이스 (요약, 원본은 `src/api/types.ts`)

| 영역 | 메서드 |
|---|---|
| 인증 | `signup` `login` `logout` `me` `changePassword` / `adminLogin` `adminLogout` `adminMe` `adminChangePassword` |
| 예비교사·세션 | `getPractice` `listSessions` `getCurrentSession` `startSession` `getSession` `sendTurn`(SSE) `endSession` |
| 시나리오 | `listScenarios` `createScenario` `getScenario` `updateScenario` `deleteScenario` `reviewScenario` `publishScenario` `getScenarioPrompt` |
| 사용자·그룹 | `listUsers` `createUser` `resetUserPassword` `deleteUser` / `listGroups` `createGroup` `updateGroup` `deleteGroup` |
| 기록·AI | `listAdminSessions` `getAdminSession` `downloadSessionsCsv`(Blob) / `getAiSettings` `updateAiRole` |

관리자 대화 테스트는 `createApi('admin')` 의 같은 세션 메서드(초안 시나리오 허용). 내부 상태 패널의 `state` 이벤트는 티켓 15 가 정하면 `SseEvent` 유니온에 더해지고 목의 `turn()` 변환에 한 줄 는다(목은 `s.progress` 를 이미 들고 있다).

## 3. 목 구현이 흉내 내는 서버 규칙 (모두 `check.ts`)

인사 발화 seq 1(student) · 진행 중 세션 사용자당 1개(409 `session_active` + `details.session_id`) · `getCurrentSession` 복구 · 턴 겹침 409 `turn_in_progress`(`turn_started_at`) · 종료 후 409 `session_ended` · 턴 상한 422 `turn_limit_reached`(기본 40) · `END SESSION` 발화 == `endSession`(같은 리포트, `sessions.report` 에 1회 저장, 재열람은 저장본) · 리포트는 서버가 카운트로(티켓 14: `total`·`reached`·`verdict`·`rows[].turns`), 분석 챗봇은 `summary` 만 · PUT 은 항상 draft + `compiled_prompt` null(초안은 예비교사에게 안 보임, 시작하면 403) · 삭제는 기록 있으면 409 `scenario_has_sessions` · 게시는 자동 점검 fail 또는 확인 4개 미만이면 422 `review_failed` · 사용자 삭제 cascade · 비밀번호 재설정 = 그 사용자 로그인 종료 · 닉네임 중복(대소문자 무시) 409 · 로그인 실패 401 `invalid_credentials` · CSV 열 = C13, BOM.

흉내 내지 않는 것(`ponytail:` 주석): 로그인 5회 지연(429), AI 설정의 공급자 판별·키 검증(3단계), `turn_started_at` 이 서버 중단으로 남는 경우(목은 `finally` 로 항상 지운다 — fog 항목은 서버 쪽 규칙).

## 4. 테스트 1개(티켓 4항)의 형태

`check.ts` 2번: 예비교사 실의 모든 응답(`getPractice`·`startSession`·`getSession`·`listSessions`·`endSession`)과 `sendTurn` 의 모든 이벤트를 깊이 걸어 `internal`·`compiled_prompt`·`progress`·`counts`·`password` 키가 없음을 확인하고, 시나리오 행은 `ScenarioPublic.extend({group_ids}).strict().parse` 로 **여분 키조차 없음**을 확인한다. 계약 수준(티켓 10 `check.ts` 1번)과 구현 수준을 둘 다 가진다. 저장소에서는 Vitest 한 파일(`client/src/api/mock/index.test.ts`).

## 5. 채택한 추천안 (사용자 일괄 승인) · 가정

1. 목 저장은 **새 키**로 시작(목업 키 재사용 안 함) — 티켓 본문 추천.
2. 목 엔진은 **공유 패키지 `runTurn`·`mockProvider` 그대로** — 티켓 본문·티켓 12 관찰 추천.
3. 미리보기는 두 모드 모두 **클라이언트 컴파일**, 서버는 게시 시만 — 티켓 9 관찰 추천.
4. 초기 데이터는 목업 SEED 전부를 `db/seed/samples/` 로 옮겨 서버 시드와 공유, 기록은 재생 — 티켓 본문 2항의 추천. 위자드 "예시로 채우기"도 **같은 샘플 파일**(가브리엘)을 import 한다(fog 항목 해소).
5. realm 은 인스턴스 속성, HTTP 는 `X-Remath-Realm` 헤더 — 이 티켓에서 새로 정함. **가정: 서버는 `any` 라우트에서 이 헤더를 읽어 그 실의 쿠키만 검사하고, 헤더가 없으면 쿠키가 하나만 있을 때 그것을 쓰고 둘 다 있으면 400**. 티켓 10 SPEC 2절에 한 줄 덧붙일 사항(관찰 댓글로 남김).
6. CSV 는 Blob.

- **가정: 목업 샘플 시나리오는 4개**(가브리엘·노아·지우·하준). 티켓 본문의 "5개"는 목업 SEED 와 맞지 않는다. 프로토타입은 가브리엘(티켓 12 `sample.mjs`)만 싣고 나머지 3개는 1단계 시드 작업에서 JSON 으로 옮긴다.
- **가정: 시드 비밀번호는 목업과 같다**(예비교사 `demo123!`, 관리자 `admin12!`). 목은 평문 비교(브라우저 안 목 데이터).

## 6. 알려진 한계 · 다른 티켓으로

- 관리자 `state` 이벤트(티켓 15): 목의 `turn()` 이 `s.progress`·`takeOverCount`·마지막 트리거를 이미 가지고 있으므로 변환 한 줄로 낼 수 있다 — 관찰 댓글.
- 샘플 시나리오 3개 JSON 변환, `seedSessions` 재생 목록, `client/src/api/` lint 규칙(`http.ts`·`mock/` 직접 import 금지)은 1단계 구현 티켓.
- 턴 상한·LLM 실패·`turn_started_at` 해제의 **화면 동작**은 fog 그대로. 이 계약은 오류 전달 경로(첫 `next()` throw vs `error` 이벤트)만 정한다.
- `prompts/` 패키지의 템플릿은 `?raw` import 로 번들해야 한다(티켓 9 프로토타입 `compile.mjs` 는 `readFileSync` 라 브라우저에서 못 쓴다) — 1단계에서 `compileScenario(s, tr, lang, templates)` 로 템플릿을 주입받게 바꾼다.
