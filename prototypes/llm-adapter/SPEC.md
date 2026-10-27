# 공급자 어댑터 인터페이스·MOCK_LLM 어댑터 계약 초안 (프로토타입, 티켓 12)

실행: `node prototypes/llm-adapter/check.ts` (Node 24, 의존성 없음). 목업의 기록 시뮬레이션 L1(도달)·L2(Taking Over 2회)을 새 파이프라인으로 재생해 목업과 같은 대사가 나오는지, 도움 요청·도달 후·분류 기준 없음 경로, MOCK 출력이 실 LLM 파서를 그대로 지나는지, 파싱 실패 1회 재요청 → Other 를 확인한다.

근거: PRD 8절, ADR-0001(3분할)·ADR-0002(서버 규칙 엔진·런타임 블록), 티켓 3(공급자 조사)·9(사용자 메시지 형식)·16(멘토 3종 호출), 목업 `engineTurn`·`classify`·`engineEnd`·`detectStd`/`detectEn`·`pickCat`·`TXT`.

## 1. 파일 (`shared/` 워크스페이스 — 가정, 티켓 10 이 이름을 확정)

```
shared/src/llm/adapter.ts         Provider · CompleteRequest · StreamEvent · AdapterError · MockContext · collect()
shared/src/llm/classification.ts  parseClassification · renderClassification (실·MOCK 공용 파서)
shared/src/engine.ts              judgeTurn · reportInput · runtimeBlock · HELP_RE · END_SESSION_RE (서버 규칙 엔진, ADR-0002)
shared/src/pipeline.ts            runTurn (엔진 + 어댑터 조립, C7 이벤트와 같은 이름)
shared/src/mock/classify.ts       detectKo · detectEn · pickCat (MOCK 분석 전용)
shared/src/mock/provider.ts       mockProvider (Provider 구현) · TXT (챗봇 대사 상수)
```

서버(2·3단계)는 `pipeline.runTurn` 을 SSE 로 직렬화하고 `turns`에 기록한다. 1단계 클라이언트 목(티켓 13)은 **같은 `runTurn` + `mockProvider`** 를 브라우저에서 돌린다. 공유 패키지는 `fs`·`process` 를 쓰지 않는다. 3단계 실 어댑터 3종은 `Provider` 만 구현해 끼운다.

## 2. 어댑터 인터페이스

```ts
interface Provider {
  readonly id: 'openai' | 'anthropic' | 'gemini' | 'mock';
  complete(req: CompleteRequest): AsyncIterable<StreamEvent>;   // delta… 뒤 done 하나. 오류는 AdapterError throw
  listModels(): Promise<string[]>;                               // 키 유효성 확인용 최소 호출(3사 모델 목록 GET, 비과금)
}
interface CompleteRequest { system: string; messages: {role:'user'|'assistant'; content:string}[]; model: string; effort?: Effort; signal?: AbortSignal; context?: MockContext }
type StreamEvent = { type:'delta'; text:string } | { type:'done'; model:string; stopReason:'end'|'length'|'other'; usage?:{input,output} }
class AdapterError extends Error { provider; code; status?; retryable }
type Effort = 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'   // 3사 합집합
```

- **system 은 최상위, messages 는 user/assistant 만** — 3사 모두 system 이 최상위 필드(OpenAI `instructions`, Anthropic `system`, Gemini `system_instruction`)고 이전 응답 ID 로 승계되지 않으므로 매 호출 보낸다(조사 티켓 3).
- **스트림 정규화는 3종 매핑**: OpenAI `response.output_text.delta`→`.delta`, Anthropic `content_block_delta`+`text_delta`→`.delta.text`, Gemini `step.delta`+`type==text`→`.delta.text`. 종료 `response.completed`/`message_stop`/`interaction.completed` → `done`. 3사 `event: error` 와 HTTP 오류 → `AdapterError{code,message,status,retryable}` 로 평탄화(429·5xx·overloaded 는 retryable).
- **effort 는 그대로 보낸다.** 모델별 허용값 검증은 `providers.json` 을 보는 AI 설정 저장 시(3단계)에 한 번. 어댑터는 clamp 하지 않고 공급자 400 을 `AdapterError` 로 올린다. 생략 = 공급자 기본값. MOCK 은 무시.
- **어댑터는 재시도하지 않는다.** 재시도·타임아웃·실패 시 화면 동작은 파이프라인/fog("LLM 호출 실패·재시도 시 화면 동작").
- `max_tokens` 류는 요청 필드가 아니라 실 어댑터 내부 상수(역할 무관, 짧은 대사라 넉넉히). 필요해지면 필드 추가.
- `collect(stream)` 은 전문이 필요한 분석 호출용. 학생·멘토는 델타를 그대로 SSE 로 흘린다.

## 3. MOCK_LLM 계약 — 선택지 (A) `context` 채택

```ts
type MockContext =
  | { role:'student';  lang; teacherText; leverage: string|null; directive: TurnDirective|null; goalReached: boolean; lines:{greet, chars, elicit[]} }
  | { role:'analysis'; lang; purpose:'turn';   teacherText; criteria }
  | { role:'analysis'; lang; purpose:'report'; report: ReportInput }
  | { role:'mentor';   lang; trigger: 1|2|3; lines:{t1,t2,t3} }
type TurnDirective = { kind:'hesitation'|'correction'|'aha'|'confused'; text }
```

- 파이프라인은 **항상** `context` 를 채운다(실 어댑터는 읽지 않음). MOCK 은 system·messages 의 내용을 파싱하지 않는다 — 단 **회전 인덱스**(elicit·도달 후 대사)는 `messages` 의 assistant 발화 중 같은 세트에 속한 수를 세어 유도한다(ADR-0002 "turns 집계로 유도", MOCK 은 대사를 그대로 내므로 정확). 혼란 대사 회전은 서버가 `takeOverCount`(turns.trigger=1 횟수)로 정해 지시 텍스트에 넣는다.
- **MOCK 학생**: 지시가 있으면 그 텍스트 그대로. 없으면 목업 순서로 도달 후 대사 회전 → 인사 휴리스틱(`chars` 의 좋아하는 것·`greet` 앞 두 문장) → `leverage` 가 Eliciting/Extending 이면 `elicit` 회전 → `idk`. `leverage` 가 null(분류 기준 없음)이면 내장 규칙(`detectKo/En`)으로 근사한다(목업과 동일).
- **MOCK 분석(turn)**: `detectKo/En` + `pickCat` → `renderClassification` 으로 `[CLASSIFICATION]` 블록만 낸다. 도움 요청·END SESSION 감지는 여기 없다(서버 상수).
- **MOCK 분석(report)**: `context.report`(= 사용자 메시지 `[REPORT]` 뒤 JSON 과 같은 값)로 목업 `TXT` 의 판정 문장 + 도달/미도달 문장을 낸다. `[세션 요약]` 머리말은 UI 문구라 제외.
- **MOCK 멘토**: 트리거 1 → `t1`, 2 → `helpLead` + `t2` 줄마다 `· `, 3 → `t3`. 접두 없음.
- `context` 없이 MOCK 을 부르면 `AdapterError('no_context')`. `signal` 이 이미 중단이면 throw.

**(B) 를 버린 이유**: 런타임 블록·마커 파싱은 템플릿 문구가 바뀌면 깨지고, en/ko 두 판을 모두 파싱해야 한다. (A) 는 타입이 계약이다. 마커(`[TURN]`/`[REPORT]`/`[TRIGGER]`)는 실 LLM 용으로 그대로 보낸다.

## 4. 서버 규칙 엔진 `judgeTurn` (ADR-0002 이식, 어댑터 밖)

`judgeTurn(text, lang, cls, lines, state) → {kind:'end'} | {kind:'help', state} | {kind:'turn', directive, trigger: 1|3|null, state}`. 순수 함수, 입력 state 를 바꾸지 않는다. 순서는 ADR-0002 의 1→6. 레버리지 카운트는 END SESSION 이 아닌 모든 발화에서 오른다(도달 후·도움 요청 포함, 목업과 동일). `state = {mis:int[], counts, goalReached, takeOverCount}` 로 `sessions.progress`·`counts`·`goal_reached` + `turns` 집계와 1:1.

- **도달 턴은 한 응답**: 지시 `kind:'aha'`, text = `교정 대사\n아하 대사`. 목업은 학생 발화 2개로 냈지만 LLM 호출 1회 = 발화 1개가 자연스럽고 `turns` 도 1행이다.
- 도움 요청 턴: 분석 호출은 하되 학생 LLM 은 부르지 않고 `TXT[lang].help` 를 학생 발화로, 멘토는 트리거 2.
- 분류 기준이 없는 시나리오: 분석 호출 없음(`compiled.analysis === null`), 멘토 트리거 1 은 발생 불가, 종료 시 `summary` 없음(클라이언트가 "분류 기준 없음" 안내 문구를 자체 표시).

## 5. 호출별 system / 사용자 메시지 (티켓 9 초안 확정)

| 호출 | system | messages |
|---|---|---|
| 학생 | `compiled.student` + `runtimeBlock(state, directive, lang)` | 이력(예비교사=user, 학생=assistant, **멘토 발화 제외**) + 이번 발화 |
| 분석(턴) | `compiled.analysis` | user 1개: `[TURN]\n학생: <직전 학생 대사>\n예비교사: <발화>` (en: `Student:`/`Teacher:`) |
| 분석(종료) | `compiled.analysis` | user 1개: `[REPORT]\n<ReportInput JSON>` — `{names, counts, verdict, reached}` (가정, 티켓 14 가 확정) |
| 멘토 | `compiled.mentor` | user 1개: `[TRIGGER] 트리거 N — <이름>` + 직전 3왕복(`예비교사:`/`학생:` 줄, 멘토 제외) |

멘토 발화를 학생 이력에서 빼는 이유: 멘토는 예비교사에게 말하며 학생은 그 대화를 듣지 않는다(PRD 1절 역할 분리). 멘토 이력에는 직전 3왕복만.

## 6. `[CLASSIFICATION]` 파서 (실·MOCK 공용)

`parseClassification(text, criteria)`: `[CLASSIFICATION]` 뒤 첫 `{…}` 를 JSON 으로 읽는다. 백틱·잡담 허용, **미지 키 무시**(후일 `targets_misconception`), 분류명이 기준에 없거나 JSON 이 깨지면 `null`. 파이프라인이 `null` 이면 **같은 요청을 1회 재전송**, 그래도 `null` 이면 `{leverage:'Other', object:'Other'|null}` 로 기록하고 진행(PRD 8절). 재요청은 어댑터가 아니라 파이프라인에 둔다(fog 항목 해소: 어댑터는 재시도 정책을 모른다).

## 7. 테스트 목록 (티켓 3항) — `check.ts` 에 모두 구현

1. L1 재생: 인사 → elicit[0] → 오개념 1 h/c → 2 h/c → 3 h → `c\n aha` + 트리거 3 + t3, 레버리지 열 `Other, Eliciting×3, Extending×2, Eliciting×2`, 상태 `{mis:[2,2,2], goalReached}`, 종료 요약 = `clean(5,2)` + 도달 문장.
2. L2 재생: Taking Over 2회 → confused[0]·[1] + 트리거 1 + t1, 요약 = `heavy(2,1)` + 미도달 문장.
3. 도움 요청(en, 분류 기준 없음): 학생 고정 문구, 트리거 2, 멘토 = helpLead + `· ` 프레임, 분석 호출 없음.
4. 도달 후: 지시·트리거 없음, 레버리지 카운트만 오름.
5. MOCK 분석 출력 → `parseClassification` 통과(`Taking Over`/`Formula Related`).
6. 실 LLM 스타일 출력(백틱·잡담·미지 키) 통과, 기준 외 이름·깨진 JSON → null, object 기준 없음 → `object:null`.
7. 깨진 출력 어댑터로 2회 실패 → `Other` 기록.
8. `context` 없는 MOCK 호출 → `AdapterError('no_context')`, 중단된 `signal` → throw.
9. 어떤 발화에도 `Mentor:`/`멘토:` 접두 없음.

## 8. 채택한 추천안 (사용자 일괄 승인) · 가정

1. (A) `context` 필드 — 위 3절.
2. 이번 턴 지시는 `context.directive` 로 전달(티켓 6 관찰의 추천). 런타임 블록은 실 LLM 용 렌더링.
3. 규칙 엔진·MOCK·파서·파이프라인을 **한 공유 패키지**에 두어 1단계 목과 2·3단계 서버가 같은 코드를 쓴다.
4. 스트림 = `AsyncIterable<StreamEvent>`(delta/done) + `AdapterError` throw. 어댑터는 재시도 없음.
5. effort 는 3사 합집합 문자열 그대로, 검증은 AI 설정 저장 시.
6. 도달 턴은 `c\n aha` 한 응답.
7. 학생 이력에서 멘토 발화 제외.
8. 파싱 재요청은 파이프라인(fog 해소).
9. MOCK 은 델타 하나로 낸다(타이핑 시연이 필요하면 분할 옵션 추가 — `ponytail:` 주석).

- **가정: 공유 패키지 이름 `shared/`** — 티켓 10 추천안과 맞춤. 10 이 다른 이름을 고르면 경로만 바뀐다.
- **가정: `[REPORT]` 페이로드 = `{names, counts, verdict, reached}` JSON** — 티켓 14 추천안(JSON 문자열 한 덩어리)에 맞춤. 14 가 필드를 늘리면 `ReportInput` 만 넓힌다.

## 9. 알려진 한계 · 다른 티켓으로

- `providers.json` 최소 스키마(모델별 effort 허용값·기본값) — 어댑터 계약이 닫혔으니 fog 에서 티켓으로 올린다.
- 턴 상한(40)·`turn_started_at` 해제·LLM 실패 시 화면 동작 — fog 그대로. 어댑터 쪽 입력은 `AdapterError.retryable` 뿐.
- 멘토 이력의 "3왕복" 은 발화 6개로 근사(도움 요청 턴의 고정 문구도 학생 발화로 센다).
- MOCK 학생의 `leverage` 가 null 일 때의 내장 규칙 근사는 분류 기준 없는 시나리오에서만 쓰인다.
