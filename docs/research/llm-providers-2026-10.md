# LLM 공급자 3종 API 형태 조사 (2026-10)

티켓: [#3](https://github.com/DomineYH/remath/issues/3) · 조사일 2026-10-27 · 1차 출처(공식 문서·공식 SDK 소스)만 사용. 확인 불가 항목은 **미확인**.

## 요약

1. 권장 엔드포인트: OpenAI `POST /responses`(Chat Completions는 유지되나 신규 프로젝트는 Responses 권장), Anthropic `POST /v1/messages`, Gemini `POST /v1beta/interactions`(2026-06 GA, 신규 개발 권장; `generateContent`는 레거시로 계속 지원).
2. effort 파라미터: OpenAI `reasoning.effort`(모델별로 허용값이 다름, `minimal`은 PRD 대상 모델 어디에도 없음), Anthropic `output_config.effort`(low/medium/high/xhigh/max, 4개 모델 모두 5단계 지원, 기본값은 모델별), Gemini `generation_config.thinking_level`(minimal/low/medium/high, `minimal`은 3.6-flash·3.5-flash-lite만).
3. 스트리밍은 3사 모두 SSE이며 텍스트 델타 위치가 다름: OpenAI `response.output_text.delta`의 `delta`(문자열), Anthropic `content_block_delta`의 `delta.text`, Gemini `step.delta`의 `delta.text`. 종료 신호는 각각 `response.completed`, `message_stop`, `interaction.completed` 후 `data: [DONE]`.
4. PRD 모델 ID 16개 중 15개 존재. `gemini-3.8-pro`만 **없음**(모델 목록 미등재, 모델 페이지 404).
5. 키 접두어는 Anthropic만 문서에 명시(`sk-ant-api...`). OpenAI(`sk-`)·Gemini(`AQ.` 인증 키 / `AIza`)는 공식 문서에 규칙 없음(Gemini `AQ.`는 2026-10-31 실제 키로 확인, #64). 키 유효성은 3사 모두 모델 목록 `GET`(토큰 과금 없음)으로 확인 가능.

## 공급자별 표

### OpenAI

| 항목 | 내용 | 출처 |
|---|---|---|
| 권장 엔드포인트 | `POST /responses` ("Creates a model response"). 마이그레이션 가이드: "While Chat Completions remains supported, Responses is recommended for all new projects." | [responses/create][oa-create], [migrate-to-responses][oa-migrate] |
| 시스템 프롬프트 | 최상위 `instructions`: "A system (or developer) message inserted into the model's context." `previous_response_id` 사용 시 이전 instructions는 승계되지 않음(매 요청 재전송). 기존 transcript 보존이 필요하면 message item으로도 전달 가능. | [responses/create][oa-create], [migrate-to-responses][oa-migrate] |
| effort 이름·위치 | `reasoning.effort` (요청 본문 `reasoning` 객체 안). "Constrains effort on reasoning for reasoning models." | [responses/create][oa-create] |
| effort 허용값 | API 전체: "Currently supported values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`." / "Not all reasoning models support every value." SDK `ReasoningEffort = Literal["none","minimal","low","medium","high","xhigh","max"]`. 기본값은 모델별("Defaults are also model-dependent"). | [responses/create][oa-create], [reasoning guide][oa-reasoning], [SDK reasoning_effort.py][oa-sdk-effort] |
| effort 모델별 차이 | 아래 모델 ID 표 참조. `gpt-6-astra`는 `none` 불가(400), `gpt-6.1-sol`은 `none`·`minimal` 불가. PRD 대상 7개 모델 페이지 어디에도 `minimal`이 없음. | [reasoning guide][oa-reasoning], 각 모델 페이지 |
| 스트리밍 형식 | `stream: true` → SSE, `event: <type>` + `data: <JSON>` 두 줄. 순서 예: `response.created` → `response.in_progress` → `response.output_item.added` → `response.content_part.added` → `response.output_text.delta`… → `response.output_text.done` → `response.content_part.done` → `response.output_item.done` → `response.completed`. 모든 이벤트에 `sequence_number`. | [responses/create 스트리밍 예시][oa-create] |
| 텍스트 델타 위치 | `type == "response.output_text.delta"` 이벤트의 `delta`(문자열). 보조 필드 `item_id`, `output_index`, `content_index`. SDK: `delta: str  # The text delta that was added.` | [SDK response_text_delta_event.py][oa-sdk-delta] |
| 종료 신호 | `response.completed`(`response.status == "completed"`, `usage` 포함). 실패는 `response.failed`(`response` 객체 포함), 중단은 `response.incomplete`. `[DONE]` 센티널 여부는 **미확인**(문서 예시에 없음). | [SDK response_completed_event.py][oa-sdk-completed], [response_failed_event.py][oa-sdk-failed], [response_stream_event.py][oa-sdk-union] |
| 오류 이벤트 | `type: "error"`, 필드 `code`(nullable), `message`, `param`(nullable), `sequence_number`. | [SDK response_error_event.py][oa-sdk-error], [streaming guide][oa-stream-guide] |
| 키 접두어 문서화 | **없음**. 인증 페이지는 `Authorization: Bearer OPENAI_API_KEY_OR_ACCESS_TOKEN`만 기술, 형식·접두어 언급 없음. | [authentication][oa-auth] |
| 최소 유효성 호출 | `GET /models` (응답 `{"object":"list","data":[{id,created,object,owned_by,shutdown_date}]}`) 또는 `GET /models/{model}`. 과금 언급 없음. | [models/list][oa-models], [models/retrieve][oa-models-get] |

### Anthropic

| 항목 | 내용 | 출처 |
|---|---|---|
| 권장 엔드포인트 | `POST /v1/messages`. 필수 헤더: `Authorization: Bearer <key>`(레거시 `x-api-key`도 지원), `anthropic-version`(예 `2026-10-21`), `content-type: application/json`. 워크스페이스 미지정 키는 `anthropic-workspace-id` 헤더 필수(없으면 400). | [API overview][an-overview], [authentication][an-auth] |
| 시스템 프롬프트 | 최상위 `system` (string 또는 `TextBlockParam[]`). "A system prompt is a way of providing context and instructions to Claude". `messages`에는 user/assistant만(대화 중 `role: "system"` 메시지는 별도 기능). | [messages][an-messages] |
| effort 이름·위치 | `output_config.effort`. "How much effort the model should put into its response." GA, 베타 헤더 불필요. | [messages][an-messages], [effort][an-effort] |
| effort 허용값 | "Valid values are `low`, `medium`, `high`, `xhigh`, or `max`." `adaptive`는 effort 값이 아님("Don't pass `adaptive` as an `effort` value"). | [messages][an-messages], [effort][an-effort] |
| effort 모델별 차이 | 4개 모델 모두 "supports all five effort levels". 기본값: fable-5-1 `high`, opus-5-5 `medium`, sonnet-5-5 `high`, haiku-5-5 `medium`. thinking 제약: fable-5-1·opus-5-5는 `thinking.disabled` 400(항상 adaptive), sonnet-5-5는 `disabled` 대신 `between_tools`(high 이하에서만), haiku-5-5는 `disabled` 허용(high 이하). Models API `capabilities.effort.{low,medium,high,xhigh,max}.supported`로 런타임 조회 가능. | [effort][an-effort], [models overview][an-models], [models/list][an-models-list], [errors][an-errors] |
| 스트리밍 형식 | `stream: true` → SSE. "Each event uses an SSE event name (for example, `event: message_stop`), and includes the matching event `type` in its data." 순서: `message_start` → `content_block_start` → (`ping`) → `content_block_delta`… → `content_block_stop` → `message_delta` → `message_stop`. | [streaming][an-stream] |
| 텍스트 델타 위치 | `content_block_delta` 이벤트, `delta.type == "text_delta"`, 텍스트는 `delta.text`. 예: `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`. (`thinking_delta`, `input_json_delta`는 무시 가능) | [streaming][an-stream] |
| 종료 신호 | `message_delta`(`delta.stop_reason`, 누적 `usage`) 뒤 `message_stop`. | [streaming][an-stream] |
| 오류 이벤트 | HTTP 200 이후에도 발생 가능. `event: error` / `data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`. 비스트리밍 오류 형태 `{"type":"error","error":{"type","message"},"request_id"}`; 타입: 400 `invalid_request_error`, 401 `authentication_error`, 402 `billing_error`, 403 `permission_error`, 404 `not_found_error`, 409 `conflict_error`, 413 `request_too_large`, 429 `rate_limit_error`, 500 `api_error`, 504 `timeout_error`, 529 `overloaded_error`. | [streaming][an-stream], [errors][an-errors] |
| 키 접두어 문서화 | **있음**(설명 수준). 인증 페이지 표: "Static `sk-ant-api...` secret sent as a bearer token in the `Authorization` header"; CLI 예시 `ANTHROPIC_API_KEY=sk-ant-api03-...`. 정규식 등 엄밀한 규칙은 없음. Admin 키 접두어는 **미확인**. | [authentication][an-auth] |
| 최소 유효성 호출 | `GET /v1/models` (`anthropic-version` 헤더 필요, 응답 `data[]`에 `id`·`capabilities`·`lifecycle` 등). 잘못된/만료 키는 401 `authentication_error`. 과금 언급 없음(토큰 소비 없음). | [models/list][an-models-list], [errors][an-errors] |

### Google Gemini

| 항목 | 내용 | 출처 |
|---|---|---|
| 권장 엔드포인트 | Interactions API `POST https://generativelanguage.googleapis.com/v1beta/interactions`. "As of June 2026, it is Generally Available and recommended for all new projects." / "While `generateContent` remains fully supported, we recommend the Interactions API for all new development." 레거시: `POST /v1beta/{model=models/*}:generateContent`, 스트리밍은 `:streamGenerateContent?alt=sse`. 인증 헤더 `x-goog-api-key`. | [interactions][gg-interactions], [migrate-to-interactions][gg-migrate], [generate-content ref][gg-gc], [api-key][gg-apikey] |
| 시스템 프롬프트 | Interactions: `system_instruction` (텍스트 생성 가이드 REST 예시는 최상위 `"system_instruction": "You are a cat..."`; API 레퍼런스는 `agent_config`(DynamicAgentConfig) 하위로 기술 → 정확한 위치 **미확인**, 실호출로 검증 필요). `previous_interaction_id`로 승계되지 않으므로 매 턴 재전송. 레거시 generateContent: `systemInstruction` ("Developer set system instruction(s). Currently, text only."). | [text-generation][gg-textgen], [interactions-api ref][gg-ref], [interactions][gg-interactions], [generate-content ref][gg-gc] |
| effort 이름·위치 | Interactions: `generation_config.thinking_level` ("The level of thought tokens that the model should generate"). 레거시: `generationConfig.thinkingConfig.thinkingLevel` (enum `ThinkingLevel`; "Recommended for Gemini 3 or later models. Use with earlier models results in an error."), 정수 `thinkingBudget`도 공존. | [interactions-api ref][gg-ref], [thinking][gg-thinking], [generate-content ref][gg-gc] |
| effort 허용값 | `minimal`, `low`, `medium`, `high` (레거시 enum: `THINKING_LEVEL_UNSPECIFIED`, `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`; SDK `ThinkingLevel` 동일). | [thinking][gg-thinking], [generate-content ref][gg-gc], [python-genai types.py][gg-sdk] |
| effort 모델별 차이 | `gemini-4-argon`: 기본 medium, low/medium/high. `gemini-3.8-flash`: 기본 medium, low/medium/high. `gemini-3.6-flash`: 기본 medium, minimal/low/medium/high. `gemini-3.5-flash-lite`: 기본 minimal, minimal/low/medium/high. 즉 `minimal`은 4-argon·3.8-flash에서 불가. | [thinking][gg-thinking] |
| 스트리밍 형식 | Interactions: 본문 `"stream": true` + URL `?alt=sse`. 이벤트: `interaction.created` → (`interaction.status_update`) → `step.start` → `step.delta`… → `step.stop` → `interaction.completed`(`usage`) → `done`. 레거시: `:streamGenerateContent?alt=sse`가 `GenerateContentResponse` 청크를 전송. | [interactions/streaming][gg-stream], [text-generation][gg-textgen], [migrate-to-interactions][gg-migrate] |
| 텍스트 델타 위치 | `event: step.delta` / `data: {"index":0,"delta":{"type":"text","text":"Hello"},"event_type":"step.delta"}` → `delta.type == "text"`일 때 `delta.text`. 레거시: `candidates[].content.parts[].text`. | [interactions/streaming][gg-stream], [generate-content ref][gg-gc] |
| 종료 신호 | `interaction.completed` 후 `event: done` / `data: [DONE]`. 레거시: 마지막 청크의 `finishReason`(`STOP`, `MAX_TOKENS`, `SAFETY` 등). | [interactions/streaming][gg-stream], [generate-content ref][gg-gc] |
| 오류 이벤트 | `event: error` / `data: {"error":{"message":"...","code":"gateway_timeout"},"event_type":"error"}`. 비스트리밍: `{"error":{"code":"invalid_request","message":"..."}}` (snake_case 코드: 400 `invalid_request`, 401 `authentication`, 403 `permission_denied`, 404 `not_found`, 429 `rate_limit_exceeded`, 500 `api_error`, 503 `service_unavailable`). 레거시 generateContent는 `429 RESOURCE_EXHAUSTED`·`503 UNAVAILABLE`·`403 PERMISSION_DENIED` 등 gRPC 상태 문자열. | [interactions/streaming][gg-stream], [api-errors][gg-errors], [troubleshooting][gg-trouble] |
| 키 접두어 문서화 | **없음**. Gemini API 키 페이지는 형식을 기술하지 않음. Google Cloud 인증 문서는 예시 문자열 `AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe`를 보여주지만 접두어 규칙은 명시하지 않음. AI Studio는 2026-05-28부터 새 키를 인증 키(auth key)로 발급([api-key][gg-apikey]: "Starting May 28, 2026, all new API keys created in Google AI Studio are automatically created as auth keys."). 인증 키 접두어 `AQ.`는 2026-10-31 실제 키에서 확인(#64). | [api-key][gg-apikey], [GCP api-keys][gg-gcpkeys] |
| 최소 유효성 호출 | `GET https://generativelanguage.googleapis.com/v1beta/models` (`pageSize` 기본 50) 또는 `GET /v1beta/models/{model}`. 헤더 `x-goog-api-key` 또는 `?key=`. 과금 언급 없음. | [models ref][gg-models-ref], [api-key][gg-apikey] |

## 모델 ID 확인표

| 공급자 | PRD ID | 판정 | 근거 (effort 허용값·기본값 포함) |
|---|---|---|---|
| OpenAI | `gpt-6-astra` | 존재 | 모델 페이지. `reasoning.effort`: low/medium/high/xhigh/max (`none` 불가). [page][oa-m-astra] |
| OpenAI | `gpt-6.1-sol` | 존재 | 모델 페이지. low/medium(기본)/high/xhigh/max (`none`·`minimal` 불가). [page][oa-m-61sol] |
| OpenAI | `gpt-6-sol` | 존재 | 모델 페이지(모델 개요 목록에는 없고 "GPT-6.1 Sol이 신규" 안내). none/low/medium(기본)/high/xhigh/max. [page][oa-m-6sol] |
| OpenAI | `gpt-6-luna` | 존재 | 모델 페이지. none/low/medium(기본)/high/xhigh/max. [page][oa-m-luna] |
| OpenAI | `gpt-5.6-terra` | 존재 | 모델 페이지(개요 목록에는 미등재). none/low/medium(기본)/high/xhigh/max. [page][oa-m-56terra] |
| OpenAI | `gpt-5.6-luna` | 존재 | 모델 페이지(개요 목록에는 미등재). none/low/medium(기본)/high/xhigh/max. [page][oa-m-56luna] |
| OpenAI | `gpt-5.5` | 존재 | 모델 페이지(개요 목록에는 미등재). none/low/medium(기본)/high/xhigh (`max` 없음). [page][oa-m-55] |
| Anthropic | `claude-fable-5-1` | 존재 | 모델 개요 "Claude API ID" 열. 기본 effort `high`, 5단계 모두. [overview][an-models] |
| Anthropic | `claude-opus-5-5` | 존재 | 동상. 기본 `medium`. [overview][an-models] |
| Anthropic | `claude-sonnet-5-5` | 존재 | 동상. 기본 `high`. [overview][an-models] |
| Anthropic | `claude-haiku-5-5` | 존재 | 동상. 기본 `medium`. [overview][an-models] |
| Gemini | `gemini-4-argon` | 존재 | 모델 목록 + thinking 표(low/medium/high, 기본 medium). [models][gg-models], [thinking][gg-thinking] |
| Gemini | `gemini-3.8-pro` | **없음** | 모델 목록 미등재, 모델 페이지 404. thinking 가이드 Go 예제 문자열에만 등장. [models][gg-models] |
| Gemini | `gemini-3.8-flash` | 존재 | 모델 목록 + thinking 표(low/medium/high, 기본 medium). [models][gg-models] |
| Gemini | `gemini-3.6-flash` | 존재 | 모델 목록 + thinking 표(minimal/low/medium/high, 기본 medium). [models][gg-models] |
| Gemini | `gemini-3.5-flash-lite` | 존재 | 모델 목록 + thinking 표(minimal/low/medium/high, 기본 minimal). [models][gg-models] |

## 어댑터 `complete({system, messages, model, effort})`에 대한 함의

- **effort는 공통 enum이 아니라 (provider, model) 단위 허용집합**이다. 공통 스케일을 `low|medium|high|max` 4단으로 두고 공급자별로 매핑하되, 모델별 불허값(OpenAI `none`/`minimal`, Gemini `minimal`, OpenAI `gpt-5.5`의 `max`)은 요청 전에 clamp 하거나 400을 그대로 올려야 한다. Anthropic은 `capabilities.effort.*.supported`, Gemini는 thinking 표, OpenAI는 모델 페이지가 기준.
- **effort 위치**: OpenAI `reasoning: {effort}`, Anthropic `output_config: {effort}`, Gemini `generation_config: {thinking_level}`. 미지정 시 기본값이 모델마다 다르므로(`medium`/`high`) MOCK 계약에는 "effort 생략 = 공급자 기본값"을 명시.
- **system 전달**: OpenAI `instructions`(최상위), Anthropic `system`(최상위), Gemini `system_instruction`(최상위로 보이나 레퍼런스와 불일치 → 1회 실호출 검증 필요). OpenAI·Gemini 모두 이전 응답 ID로 system이 승계되지 않으므로 어댑터는 매 호출 system을 보낸다.
- **스트림 정규화**: `(event.type, path)` 3종만 매핑하면 됨 — OpenAI `response.output_text.delta`→`.delta`, Anthropic `content_block_delta`+`delta.type==text_delta`→`.delta.text`, Gemini `step.delta`+`delta.type==text`→`.delta.text`. 종료: `response.completed` / `message_stop` / `interaction.completed`(또는 `[DONE]`). 오류: 3사 모두 `event: error`이고 payload 형태가 다름(OpenAI `{code,message,param}`, Anthropic `{error:{type,message}}`, Gemini `{error:{code,message}}`) → 공통 `StreamError{code,message}`로 평탄화.
- **키 검증**: 접두어 검사는 Anthropic(`sk-ant-`)만 문서 근거가 있고 OpenAI·Gemini는 근거 없음 → 접두어는 UX 힌트로만 쓰고, 실제 검증은 모델 목록 `GET`(3사 모두 토큰 비과금) 결과의 2xx/401로 판정.
- Anthropic은 `anthropic-version` 헤더가 필수이고, 워크스페이스 미지정 키면 `anthropic-workspace-id`도 필요 — 어댑터 설정에 선택 필드로 둔다.

## 오류 종류와 재시도 판정 (#89, 2026-11-01 확인)

비-2xx 본문에서 어댑터가 읽는 오류 종류(`AdapterError.kind`): OpenAI `error.code ?? error.type`, Anthropic `error.type`, Gemini(`generateContent`) `error.status`. 분류는 상태 코드로 하되, **429 본문의 종류가 결제·한도 소진 집합에 들면 `provider_rejected`(재시도 불가)**로 뒤집는다. 집합은 `server/src/providers/call.ts`의 `QUOTA_KINDS` 한 곳에 있다. 지금 문서로 확정되는 것은 OpenAI뿐이다.

| 공급자 | 상태·종류 | 뜻 | 어댑터 판정 | 출처 |
|---|---|---|---|---|
| OpenAI | 429 `type=rate_limit_error`, `code=slow_down` 또는 code 없음 | rate limit(요청량 급증 포함). 공급자 안내: `Retry-After`가 있으면 따르라고 함(어댑터는 읽지 않음) | `provider_unavailable`, 재시도 가능 | [error codes][oa-errors] |
| OpenAI | 429 `type=insufficient_quota`, `code` ∈ `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded` | 선불 크레딧 소진·조직/프로젝트 월 지출 상한·OpenAI 부여 사용 한도. "Retrying billing, spend, or quota errors won't restore API access." | `provider_rejected`, 재시도 불가 | [error codes][oa-errors] |
| OpenAI | 503 `service_unavailable_error` / `server_is_overloaded` | 일시 과부하 | `provider_unavailable`, 재시도 가능 | [error codes][oa-errors] |
| Anthropic | 402 `billing_error` | 결제 문제 | `provider_rejected`(비-429 4xx) | [errors][an-errors] |
| Anthropic | 400 `invalid_request_error` | 요청 오류. 조직·워크스페이스 지출 한도 도달에도 쓰인다 | `provider_rejected` | [errors][an-errors] |
| Anthropic | 429 `rate_limit_error` | rate limit과 사용 티어 월 지출 상한이 같은 type이다(상한 429는 `retry-after` 헤더가 없다는 것만 다름) → type으로 구별 불가 | `provider_unavailable`, 재시도 가능(종류는 로그에 남김) | [errors][an-errors] |
| Anthropic | 529 `overloaded_error` | 일시 과부하 | `provider_unavailable`, 재시도 가능 | [errors][an-errors] |
| Gemini | 429 `RESOURCE_EXHAUSTED` | 일시 rate limit과 일일 쿼터 소진이 같은 status다 → 구별 불가 | `provider_unavailable`, 재시도 가능(종류는 로그에 남김) | [api-errors][gg-errors], [troubleshooting][gg-trouble] |
| Gemini | 403 `PERMISSION_DENIED`, 402 | 미납·무료 티어 불가 등 결제·권한 문제 | `provider_rejected` | [api-errors][gg-errors], [troubleshooting][gg-trouble] |

- 본문 모양: OpenAI `{"error":{"message","type","code","param"}}`, Anthropic `{"type":"error","error":{"type","message"},"request_id"}`, Gemini `{"error":{"code":<number>,"message","status"}}`.
- 스트림 중 오류(OpenAI `response.failed`의 `error.code`, `event: error`의 `code`)에도 같은 집합을 적용한다.
- Gemini Interactions API에는 `quota_exceeded`·`payment_required`·`failed_precondition` 코드가 따로 있지만 지금 어댑터 경로(`generateContent`)가 아니다.
- 종류는 `llm call failed`·`turn failed`·`ai key rejected by provider` 로그에 싣되, **공급자가 문서로 밝힌 값만** 싣는다: `server/src/providers/call.ts`의 `LOGGED_KINDS`(OpenAI = [error codes][oa-errors] 가이드의 type·code와 openai-python [`ResponseError.code`][oa-sdk-resp-error], Anthropic = [errors][an-errors] 페이지의 `error.type` 전부, Gemini = Google API 오류 모델 [AIP-193][gg-aip193]이 가리키는 [`google.rpc.Code`][gg-rpc-code] 상태 이름(`OK` 제외)). 목록에 없는 값은 어댑터를 나갈 때 버리므로, 공급자 문구·메시지·키 조각은 kind로 로그에 닿지 않는다. 분류(`QUOTA_KINDS`·거절 판정)는 목록과 무관하게 원래 값을 본다. OpenAI 401 본문의 `code: invalid_api_key`는 실제 401 응답에서 관찰된 값이라 목록에 넣었다([openai-python issue #1968](https://github.com/openai/openai-python/issues/1968)); error codes 가이드에는 없다. `AdapterError` 생성자의 모양 규칙(한 가지 대소문자의 64자 이하 식별자)은 목·파이프라인 오류까지 덮는 일반 규칙으로 남는다. 메시지 본문·키는 로그에 넣지 않는다(Q9).

## 잔액·한도 조회 API와 키 저장 시 프로브 (#94, 2026-11-01 확인)

일반 API 키(관리자가 AI 설정에 넣는 키)로 남은 크레딧·지출 상한을 읽는 엔드포인트는 3사 모두 없다. 그래서 크레딧 0·지출 상한 도달 키도 모델 목록 GET(비과금)은 통과한다(#89, 2026-11-01 production G4 OpenAI analysis 키).

| 공급자 | 잔액·한도 조회 | 일반 API 키로 가능? | 출처 |
|---|---|---|---|
| OpenAI | Usage·Costs API는 과거 사용량·지출만 돌려주고 잔액·상한 엔드포인트가 없다. 예시는 모두 `OPENAI_ADMIN_KEY` | 불가 | [usage][oa-usage] |
| Anthropic | Usage·Cost API는 "Admin API credentials required … workspace API keys don't work". 402 `billing_error`·429 월 지출 상한은 오류 페이지에만 있다 | 불가 | [usage-cost-api][an-usage], [errors][an-errors] |
| Gemini | 결제 문서는 잔액·쿼터 확인을 AI Studio 화면으로만 안내한다("the Gemini API will only serve requests if you have a positive Prepay credit balance") | 불가 | [billing][gg-billing] |

**결정**: 관리자가 새 키를 저장할 때(`PUT /api/admin/ai/:role`, `MOCK_LLM=0`, `key_source=own` + 새 키) 모델 목록 GET이 통과하면 **고른 모델로 최소 유료 호출 1회**를 더 보낸다(`server/src/routes/admin-ai.ts`). Admin 키를 따로 받는 것은 범위 밖이다.

- 프로브 모양: `system` = `Reply with the single word OK.`, `messages` = `[{role:'user', content:'OK'}]`, `model` = 저장 요청의 `model`(파이프라인이 실제로 쓸 모델이라 "키는 유효하지만 이 모델은 못 쓴다"도 잡힌다), 출력 상한 `PROBE_MAX_OUTPUT_TOKENS = 16`(OpenAI `max_output_tokens`, Anthropic `max_tokens`, Gemini `generationConfig.maxOutputTokens` — 어댑터는 기존 effort 표기처럼 snake_case `generation_config.max_output_tokens`로 보내고 effort와 한 객체에 합친다), `effort` 없음(공급자 기본값), 기한 `LIST_MODELS_TIMEOUT_MS`(10초). 비용은 저장 1회당 입력 수십 토큰 + 출력 ≤16 토큰.
- 판정: `done`(stop `length` 포함) = 통과. `provider_rejected`(결제·크레딧·한도 소진 429, 402, 403, 모델 없음 404 등) = **저장 거부** — 모델 목록 실패와 같은 `provider_rejected` 응답(`details` = `{status, 마스킹된 message}`)과 `ai key rejected by provider` 로그. `provider_unavailable`(rate limit 429, 5xx, 기한 초과, 네트워크) = 확인 불가로 보고 저장, `ai key probe inconclusive` 로그(`role, provider, status, kind`) 1줄. 어댑터 `stream()`이 `llm call`/`llm call failed` 줄을 따로 남긴다. 프롬프트·응답 텍스트·공급자 문구·키는 어디에도 기록하지 않는다.
- 최소값: Anthropic `max_tokens`는 최소 0이라 16은 유효하다([messages][an-messages]). OpenAI `max_output_tokens`의 최소값은 이 저장소 문서에 적혀 있지 않고 이번 작업에서 [responses/create][oa-create]를 다시 확인하지 않았다 → 16을 쓴다(미확인, 실 저장 1회로 400이 아닌지 확인 필요). Gemini `maxOutputTokens`의 최소값 언급은 찾지 못했다.
- 한계: Anthropic 사용 티어 월 지출 상한 429(`rate_limit_error`)와 Gemini 일일 쿼터 429(`RESOURCE_EXHAUSTED`)는 rate limit과 구별되지 않아(위 절) 프로브에서도 `provider_unavailable` → 저장된다. 프로브는 저장 순간만 본다(주기적 재확인 없음).

## 출처

[oa-create]: https://developers.openai.com/api/reference/resources/responses/methods/create
[oa-migrate]: https://developers.openai.com/api/docs/guides/migrate-to-responses
[oa-reasoning]: https://developers.openai.com/api/docs/guides/reasoning
[oa-stream-guide]: https://developers.openai.com/api/docs/guides/streaming-responses
[oa-auth]: https://developers.openai.com/api/docs/api-reference/authentication
[oa-errors]: https://developers.openai.com/api/docs/guides/error-codes
[oa-models]: https://developers.openai.com/api/reference/resources/models/methods/list
[oa-models-get]: https://developers.openai.com/api/reference/resources/models/methods/retrieve
[oa-models-page]: https://developers.openai.com/api/docs/models
[oa-m-astra]: https://developers.openai.com/api/docs/models/gpt-6-astra
[oa-m-61sol]: https://developers.openai.com/api/docs/models/gpt-6.1-sol
[oa-m-6sol]: https://developers.openai.com/api/docs/models/gpt-6-sol
[oa-m-luna]: https://developers.openai.com/api/docs/models/gpt-6-luna
[oa-m-56terra]: https://developers.openai.com/api/docs/models/gpt-5.6-terra
[oa-m-56luna]: https://developers.openai.com/api/docs/models/gpt-5.6-luna
[oa-m-55]: https://developers.openai.com/api/docs/models/gpt-5.5
[oa-sdk-effort]: https://github.com/openai/openai-python/blob/main/src/openai/types/shared/reasoning_effort.py
[oa-sdk-delta]: https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_text_delta_event.py
[oa-sdk-completed]: https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_completed_event.py
[oa-sdk-failed]: https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_failed_event.py
[oa-sdk-error]: https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_error_event.py
[oa-sdk-resp-error]: https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_error.py
[oa-sdk-union]: https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_stream_event.py
[an-overview]: https://platform.claude.com/docs/en/api/overview
[an-auth]: https://platform.claude.com/docs/en/manage-claude/authentication
[an-messages]: https://platform.claude.com/docs/en/api/messages
[an-effort]: https://platform.claude.com/docs/en/build-with-claude/effort
[an-stream]: https://platform.claude.com/docs/en/build-with-claude/streaming
[an-errors]: https://platform.claude.com/docs/en/api/errors
[an-models]: https://platform.claude.com/docs/en/about-claude/models/overview
[an-models-list]: https://platform.claude.com/docs/en/api/models-list
[gg-interactions]: https://ai.google.dev/gemini-api/docs/interactions
[gg-migrate]: https://ai.google.dev/gemini-api/docs/migrate-to-interactions
[gg-ref]: https://ai.google.dev/api/interactions-api
[gg-textgen]: https://ai.google.dev/gemini-api/docs/text-generation
[gg-thinking]: https://ai.google.dev/gemini-api/docs/thinking
[gg-stream]: https://ai.google.dev/gemini-api/docs/interactions/streaming
[gg-errors]: https://ai.google.dev/gemini-api/docs/api-errors
[gg-trouble]: https://ai.google.dev/gemini-api/docs/troubleshooting
[gg-aip193]: https://google.aip.dev/193
[gg-rpc-code]: https://github.com/googleapis/googleapis/blob/master/google/rpc/code.proto
[gg-gc]: https://ai.google.dev/api/generate-content
[gg-models]: https://ai.google.dev/gemini-api/docs/models
[gg-models-ref]: https://ai.google.dev/api/models
[gg-apikey]: https://ai.google.dev/gemini-api/docs/api-key
[gg-gcpkeys]: https://docs.cloud.google.com/docs/authentication/api-keys
[gg-sdk]: https://github.com/googleapis/python-genai/blob/main/google/genai/types.py
[oa-usage]: https://developers.openai.com/api/reference/resources/organization/subresources/usage
[an-usage]: https://platform.claude.com/docs/en/manage-claude/usage-cost-api
[gg-billing]: https://ai.google.dev/gemini-api/docs/billing
