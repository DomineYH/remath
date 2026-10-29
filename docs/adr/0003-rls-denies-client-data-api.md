---
status: accepted
---

# RLS는 클라이언트 Data API 경로를 전면 거부하고, 사용자 단위 접근 규칙은 서버 코드가 강제한다

PRD 5절은 "서버는 service role, RLS는 2차 방어"라 하고 6절은 예비교사 단위 접근 규칙을 RLS로 적는다. 그러나 조사([Supabase RLS·뷰·service role 동작 조사](https://github.com/DomineYH/remath/issues/2), `docs/research/supabase-rls-views.md`)로 service role은 `BYPASSRLS`라 **서버 경로에서는 RLS가 아무것도 막지 않음**이 확인됐다. 또 브라우저는 Node API만 보고(5절) 자체 인증(닉네임 + argon2)을 쓰므로 `auth.uid()` 기반 정책을 평가할 Supabase Auth JWT가 없다. 그래서 RLS의 주체를 **anon/authenticated 역할(Data API 직접 접근)** 로 한정하고 그 경로를 전면 거부한다. 6절의 사용자 단위 규칙은 서버 코드가 강제하되, 예비교사용 시나리오 읽기는 원본 테이블 대신 SQL 뷰·함수만 거치게 한다. (티켓의 (A)안)

## 규칙

1. 모든 `public` 테이블은 `enable row level security`, 정책 0개. anon/authenticated에는 테이블·뷰·시퀀스·함수 어느 것도 GRANT하지 않는다(Supabase 기본 GRANT와 default privileges를 REVOKE). service_role·postgres의 권한은 그대로 둔다.
2. 뷰는 모두 `with (security_invoker = true)`. definer 뷰는 `postgres` 소유라 RLS를 우회하므로 금지.
3. 서버는 `SUPABASE_SERVICE_KEY`로 Data API에 접속한다(PRD 7절 5단계의 환경변수). 접근 제어는 서버 핸들러가 로그인 사용자(`users.id`, `role`)로 질의를 한정하는 것이 **유일한 방어**다: `sessions`·`turns`는 `user_id = 로그인 사용자`, 관리자는 전체, `ai_settings`·`audit_log`는 관리자 핸들러와 턴 파이프라인만.
4. 예비교사용 시나리오 읽기는 두 SQL 객체만 거친다: 뷰 `scenarios_public`(`scenarios`에서 `internal`·`compiled_prompt`를 뺀 것)과 함수 `teacher_scenarios(user_id uuid) returns setof scenarios_public`(`status = 'published'`이고 `group_scenarios`·`group_members`로 그 사용자의 그룹에 할당된 행, `exists`로 중복 없음). 원본 `scenarios`는 관리자 핸들러와 턴 파이프라인(컴파일 프롬프트·내부 설정 읽기)만 읽는다. 세션 시작(`server/src/routes/sessions.ts`의 `POST /api/sessions`: `teacher_scenarios`로 할당을 확인한 뒤 `start_session` 전에 `lang`·`internal`·인사 발화를 읽는다)은 턴 파이프라인에 든다. 예외로 세션 투영(`server/src/projection.ts`의 `SESSION_SELECT`, 예비교사 기록·관리자 기록·CSV가 같이 씀)은 세션 lang 스냅샷 판 이름(M-9)을 고르려고 `scenarios`를 거쳐 `scenario_translations(lang, name)`만 임베드한다(`scenarios_public`은 활성 언어판만 담아 그 이름을 줄 수 없다). `internal`·`compiled_prompt`를 비롯한 `scenarios` 열은 고르지 않는다.
5. 서버 경로의 2차 방어(전용 NOBYPASSRLS 로그인 역할 + 직접 Postgres 접속 + `set_config`로 사용자 전달, 티켓의 (B)안)는 이 지도 밖이다. 2단계 이후 별도 효력으로 검토한다.

## Consequences

- PRD 5절 "RLS는 2차 방어"는 "anon 키 유출·Data API 직접 호출에 대한 방어"로 읽는다. GRP-2의 "RLS + API 검사"는 서버 경로에서는 API 검사만 뜻한다.
- 마이그레이션 초안은 테이블마다 RLS on, anon/authenticated REVOKE, `security_invoker` 뷰, `teacher_scenarios` 함수를 담는다. anon/authenticated용 정책은 쓰지 않는다.
- PRD 7절 4단계 스모크("anon 키로 `scenarios.internal` 읽기 거부")는 psql(`postgres`는 BYPASSRLS)이 아니라 **anon 키 → Data API 호출**로 해야 의미가 있다. 세부는 2단계 `deploy.sh`.
- 예비교사 API 응답 타입은 `scenarios_public` 컬럼 집합에서 파생한다. `internal`·`compiled_prompt`는 타입에 아예 없다.
- 근거 티켓: [RLS 2차 방어의 주체와 범위 결정](https://github.com/DomineYH/remath/issues/7).
