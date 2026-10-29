# 3단계(LLM 연동·출시) shaping — 확정 결정 (2026-10-29)

`/grill-with-docs shape stage 3`의 결과. 1라운드는 발주자가 추천안대로 확정했고, 2·3라운드는 발주자 위임으로 추천안을 그대로 채택했다. 이 문서는 3단계 스펙 이슈의 원본이다. 용어는 `GLOSSARY.md`(공급자·공급자 어댑터·목 모드·키 금고·키 출처·Effort·부분 대사), 스트리밍 프로토콜은 ADR-0004.

## 사실(코드 확인)

- `shared/src/engine/adapter.ts`: 어댑터 인터페이스(델타 스트림·`listModels`·`AdapterError.retryable`)는 이미 있고 실 어댑터 3종만 없다.
- `runTurn`은 `Bots.model` 하나로 세 역할을 부른다. `ai_settings`는 역할별 공급자·모델·effort·키 출처 구조다 → 역할별 설정이 파이프라인에 안 내려온다.
- SSE `student`·`mentor`에 `final: boolean`이 있고 `ChatScreen`은 이벤트마다 텍스트를 덮어쓴다.
- `PUT /api/admin/ai/:role`은 `provider_rejected`를 선언했고 i18n 문구가 있다. 2단계는 키 원문을 버린다(O-7).
- `TURN_TIMEOUT_MS` 기본 120초, `MAX_TURNS` 40. 관측은 pino 로그만.
- 조사 #3 결과는 `research/llm-providers-2026-10` 브랜치의 `docs/research/llm-providers-2026-10.md`에만 있다.
- Supabase 무료 플랜 2 프로젝트: dev 활성, 스테이징 A 일시정지, B 활성. 실서버 호스트·도메인·TLS 없음.

## 결정

### 범위
- **Q1** PRD 10절 + #35 "3단계" 목록 그대로: 실 어댑터 3종, 키 금고, AI 설정 실제 저장 + `listModels` 검증 + `provider_rejected`, 공급자별 실패율·지연 집계, 부하·보안 점검, 실서버 배포, G4. 추가: **역할별 모델·effort를 파이프라인에 실제 적용**. `client/src/screens`·`components`·`i18n` 동결 유지.
- **Q12** 조사 문서를 main에 병합해 1차 근거로 삼는다.
- **Q17** 2단계와 같은 진행: 스펙 이슈 1개 + 자식 티켓(blocked_by) → herdr 워커(opus 5.5 high) → codex 리뷰 → 통합 브랜치 → PR. 워크 오더 트레일러·STATUS 대기·잔류 dev 서버 정리 규칙 유지.

### 턴 파이프라인
- **Q2/Q20** 학생·멘토는 누적 텍스트 `final:false` 반복 + `final:true` 1회(ADR-0004). 분석은 `collect`. `runTurn` 이벤트에 `final` 추가. `client/src/api/mock/sessions.ts`는 `final` 전달 한 줄만 변경 허용.
- **Q21** `Bots = { student|analysis|mentor: { provider, model, effort } }`. 공유 `model` 폐기. 목은 `'mock'`.
- **Q3** `ai_settings` 3행을 턴 시작 시 1회 읽어 `Bots` 구성. 캐시 없음.
- **Q19** 키 출처가 다른 역할이면 턴 시작 시 출처 역할의 암호문을 복호해 쓴다(저장 시 복사 없음).
- **Q7** 자동 재시도 없음(분석 파싱 1회 재요청만 유지). 401·403·400 → `provider_rejected`(retryable false), 429·5xx·네트워크·타임아웃 → `provider_unavailable`(retryable true). 이 턴의 발화는 기록하지 않는다(기존).
- **Q8** 턴 전체 `TURN_TIMEOUT_MS` 120초 유지, 호출별 상한 없음.
- **Q24** `stopReason: 'length'`는 정상 처리 + 경고 로그.
- **Q18** 복호 실패 → `provider_unavailable`(retryable false) + 서버 로그 `vault_decrypt_failed`. 관리자가 키 재등록.

### 목 모드 / 실 모드
- **Q4** `MOCK_LLM=0` → 실 어댑터, `KEY_VAULT_SECRET` 필수(없으면 기동 실패). `MOCK_LLM=1` → 세 역할 모두 목. 역할별 혼합 없음. 실 모드에서 키 없는 역할이 턴에 걸리면 `provider_unavailable`. 라우트 표·오류 코드 추가 없음.

### 키 금고 / AI 설정
- **Q6** `KEY_VAULT_SECRET` = 32바이트(base64 또는 hex). 암호문 = `iv‖tag‖ct` base64 한 문자열 → `ai_settings.key_ciphertext`. 비밀 교체(재암호화)는 범위 밖, README에 "비밀을 바꾸면 키를 다시 등록한다".
- **Q25** 비밀은 운영자가 `openssl rand -base64 32`로 만들어 런타임 env에 넣는다. `deploy.sh`는 `MOCK_LLM=0`이면서 비어 있으면 1단계 전에 실패. 자동 생성 없음.
- **Q5** `api_key`가 오면 `listModels` 1회 → 실패 시 `provider_rejected`(502, `details`에 상태 코드·메시지 요약) 저장 안 함. 모델 ID 목록 대조는 하지 않음(직접 입력 허용).
- **Q23** `listModels`: OpenAI `GET /v1/models`, Anthropic `GET /v1/models`, Gemini `GET /v1beta/models`. 2xx = 유효.
- **Q32** 감사: `ai.update`의 `meta.key_changed`로 충분. 새 액션 없음. 검증 실패는 로그만.
- **Q31** `providers.json` 변경 없음(`gemini-3.8-pro`는 이미 제외).

### 어댑터
- **Q10/Q22** OpenAI `POST /v1/responses`(stream, `reasoning.effort`), Anthropic `POST /v1/messages`(stream, `output_config.effort`), Gemini `POST /v1beta/models/{m}:streamGenerateContent?alt=sse`(`generation_config.thinking_level`, `system_instruction` 최상위). effort null이면 매개변수 생략.
- **Q11** SDK 없이 Node `fetch` + SSE 파서 하나. 위치 `server/src/providers/*.ts`(클라이언트 번들 밖).
- **Q9** 호출마다 pino 1줄 `{provider, model, role, ms, ok, code, usage}`. 발화·키는 절대 안 넣음. 집계 엔드포인트·테이블 없음.
- **Q30** 어댑터는 녹음 픽스처로 네트워크 없는 단위 테스트. 실키 1회 점검은 프롬프트 점검 티켓에서. `test:http`에 AI 설정 저장 경로(가짜 키 → `provider_rejected`) 추가.

### 배포 / 검증 / 게이트
- **Q13** 실서버 = 사용자가 준비하는 Linux 호스트 + 도메인 + Caddy TLS, 거기서 `deploy.sh --new`. 슬롯 확보를 위해 **스테이징 A 삭제**. 호스트·도메인·DNS는 ready-for-human.
- **Q29** 스테이징 B 유지, dev 활성 유지.
- **Q26** Caddy compose는 추가하지 않고 README에 Caddyfile 5줄(`reverse_proxy 127.0.0.1:3000`).
- **Q14** 부하: 스테이징 `MOCK_LLM=1`, 30 세션 동시 턴, 섞임 0·429/5xx 0. 보안: `/security-review` + `npm audit` + 로그에 발화·키 없음 + 로그인 지연·RLS 스모크 재확인. 외부 침투 테스트 없음. 결과 `docs/` 1쪽.
- **Q27** 부하 스크립트 `server/src/cli/load.ts`(fetch + `test-http/jarFetch`, 세션별 `seq` 단조·순서 검사), `npm run load -w server`, CI 밖, 새 의존성 없음.
- **Q15** `docs/g4-runbook.md`: 실서버 배포 → 키 등록 → 그룹·사용자 → 예비교사 세션 종료 → CSV. 사람 서명.
- **Q16** G4 전 프롬프트 실모델 점검 티켓 1개(관리자 대화 테스트, `prompts/`만 수정, 자동 점검 6개 통과 유지).
- **Q33** ADR은 0004(누적 스트리밍)만. SDK 미사용·전역 MOCK 스위치는 ADR 기준 미달.

## 티켓 분할 (Q28)

| # | 티켓 | 막는 것 |
|---|---|---|
| 1 | 조사 문서 병합 + 3단계 스펙 이슈 게시 | — (사람 승인) |
| 2 | 공유: `Bots` 역할별 구조 + `final` 누적 스트리밍 + 목 어댑터·클라이언트 목 한 줄 | 1 |
| 3 | 키 금고 `server/src/vault.ts` + `PUT /api/admin/ai/:role` 실제 저장·`listModels`·`provider_rejected` | 1 |
| 4 | 어댑터 3종 + SSE 파서 + 호출 로그, 픽스처 단위 테스트 | 1 |
| 5 | 서버 턴 통합: `MOCK_LLM=0`, `ai_settings`→복호→`Bots`, 오류 매핑, 누적 송출 | 2, 3, 4 |
| 6 | 배포: `deploy.sh` 비밀 검사, README(env 표·Caddy·비밀 교체), G4 런북 초안 | 5 |
| 7 | 프롬프트 실모델 점검(`prompts/`만) | 5, 9 |
| 8 | 부하·보안 점검 + `docs/` 1쪽 | 5 |
| 9 | ready-for-human: 호스트·도메인·DNS·Caddy·공급자 키 3종·A 삭제 | — |
| 10 | G4 사람 서명 | 6, 7, 8, 9 |

## 외부 공개·비가역 행위(발주자 확인 필요)

조사 브랜치 병합 push, 스펙 이슈·티켓 게시, 스테이징 A 삭제, 실서버 배포.
