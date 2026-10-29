# 부하·보안 점검 (2026-10, #60 · Q14 · Q27)

**실행 환경**: 이 브랜치(`stage3/60-load-security`, load.ts 커밋 `b7e3f2d` = `stage3/integration` 9da1a6d + load.ts)의 서버를 로컬(127.0.0.1:3962)에서 띄우고 **스테이징 B의 DB**에 붙였다. `MOCK_LLM=1`(기동 로그 `llm: mock` 확인). 배포된 B 컨테이너는 건드리지 않았다. 2026-10-29 실행.

## 부하 결과 — 30명 × 10턴 동시 (`npm run load -w server`, run `vsih`)

| 항목 | p50 | p95 | n |
|---|---|---|---|
| 첫 SSE 이벤트 지연 | 1398 ms | 1924 ms | 300 |
| 턴 지연(`done`까지) | 1746 ms | 2291 ms | 300 |

| 실패 | 건수 |
|---|---|
| HTTP 429 | 0 |
| HTTP 5xx | 0 |
| SSE `error` | 0 |
| 검사 실패(seq 빈틈·예비교사 발화 순서) | 0 |
| 기타 | 0 |

전체 31.4초. 세션 30개 모두 `turns.seq`가 1부터 빈틈 없이 증가했고, 예비교사 발화 300개가 보낸 순서·내용 그대로 기록됐다(섞임 없음).

**정리**: 만든 것 = 사용자 `load-vsih-1`…`load-vsih-30`(관리자 API로 생성), 임시 그룹 `load-vsih`(구성원 30명 + 기존 게시 시나리오 1개 연결). 실행 후 그룹과 사용자 30명을 관리자 API로 삭제(기록 cascade). 남은 `load-*` 사용자 0, `load-*` 그룹 0 확인. ai_settings·시나리오·다른 그룹은 변경하지 않았다.

## 보안 항목

| 항목 | 결과 |
|---|---|
| `/security-review` (main 대비 브랜치 변경분: #54–#57 + load.ts) | 신뢰도 8 이상 발견 0건. 확인: 관리자 실 강제(`PUT /api/admin/ai/:role`), `:role` enum 검사, 응답·감사 로그에 `key_masked`만, 호출 로그에 키·발화 없음, 예비교사 SSE `error`는 고정 문구, AES-256-GCM(매번 랜덤 12바이트 IV, 태그 검증), 공급자 URL 고정 https·키는 헤더로만 |
| `npm audit --omit=dev` | 0 vulnerabilities |
| 서버 로그 grep (부하 실행 중 로그 1126줄) | 예비교사 발화 표지 `LDTX-`·발화 본문 0건, `sk-` 0, `AIza` 0, `"password"` 필드 0, 쿠키 값 0, SUPABASE service/anon 키·관리자 비밀번호 값 0. `KEY_VAULT_SECRET`은 B env에 없음(MOCK_LLM=1이라 읽지 않음) → 해당 없음 |
| 로그인 5회 실패 → 429 | 없는 닉네임으로 `/api/auth/login`, `/api/admin/auth/login` 각각 6회: `401 ×4 → 429 ×2` (5번째 실패부터 429) |
| RLS 스모크 `npm run db:smoke -w server` (B, env = deploy.env의 `REMATH_ENV_FILE`=server.env) | ok 3/3: admin user 1, ai_settings 3, anon → `scenarios.internal` HTTP 401 / 42501 거부 |

외부 침투 테스트는 하지 않았다(티켓 범위 밖).

## 열린 발견 사항

High·Medium: **없음**.

| # | 심각도 | 내용 | 조치 |
|---|---|---|---|
| 1 | Low (심층 방어) | `server/src/vault.ts` `open`이 GCM 태그 길이를 16바이트로 고정하지 않아 잘린 태그도 받아들일 수 있다. 악용하려면 DB 쓰기 권한(service key)이 필요하므로 실질 위험 없음 | `createDecipheriv(..., { authTagLength: 16 })` 한 줄. 별도 티켓 판단 |
| 2 | Info | `load.ts`의 임시 예비교사 비밀번호가 `Math.random` 기반으로 약하다. 실행 동안만 존재하고 finally에서 삭제 | 운영 DB에는 실행하지 않는다 |

## 참고

- 로컬 서버는 기동 시 `releaseTurns`로 B DB의 진행 중 턴 표시를 해제한다. 실행 시점에 B의 배포 컨테이너에 진행 중 턴이 있었다면 영향을 받았을 수 있다(확인하지 않음; 부하 실행 중 5xx·SSE error는 0).
- 지연 수치는 MOCK 공급자 기준이다: 서버·Supabase 왕복 비용이며 실제 LLM 지연은 포함하지 않는다.
