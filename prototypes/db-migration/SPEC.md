# DB 마이그레이션 초안 `0001_init.sql` (프로토타입, 티켓 11)

파일: `db/migrations/0001_init.sql` (저장소에서는 `db/` 워크스페이스, 지도 C3). 점검: `PGLITE_DIR=<pglite 설치 폴더> node prototypes/db-migration/check.mjs` — PGlite(Postgres 18 WASM)로 적용 → 재적용 거부 → 샘플 행 → 예비교사 읽기 경로 → anon/authenticated 전면 거부 → service_role 우회까지 확인한다. 저장소에는 의존성을 넣지 않는다.

근거: PRD 6·7·9·11절, 지도 C3·C8·C9·C10·C11·C12·C13, ADR-0002(판정·런타임 블록), ADR-0003(RLS 범위), 티켓 2(RLS 조사)·5·6·7·9가 이 티켓에 넘긴 관찰.

## 1. 테이블 (PRD 6절 10개 + `auth_sessions` + `schema_migrations`)

| 테이블 | PRD 대비 변경 | 비고 |
|---|---|---|
| `users` | 추가 제약: `lower(nickname)` unique, 관리자 1행 partial unique | PRD 9절 대소문자 무시 중복 금지, AUTH-5 |
| `groups` | 없음 | |
| `group_members`, `group_scenarios` | 복합 PK, `id`·`updated_at` 없음(`created_at`만) | 연결 테이블은 수정이 없다 |
| `scenarios` | `compiled_prompt` **text → jsonb** `{student, analysis\|null, mentor}`; `check (status='draft' or compiled_prompt is not null)` | 티켓 9 컴파일 결과 3개. 컬럼 이름은 유지해 PRD·ADR·GLOSSARY 참조가 그대로 맞는다 |
| `scenario_translations` | `desc` → **`description`** | `desc`는 SQL 예약어. 유일한 컬럼명 변경 |
| `sessions` | 추가 `progress jsonb {"mis": int[]}`, `report jsonb`, `turn_started_at timestamptz` | ADR-0002 카운터, 리포트 저장(티켓 14 추천안 가정), C8 진행 중 턴 표시 |
| `turns` | `trigger smallint 1..3`, `unique (session_id, seq)` | 티켓 6 관찰. unique 가 요구 인덱스를 겸한다 |
| `auth_sessions` (신규) | `user_id`, `realm teacher\|admin`, `token_hash unique`, `expires_at`, `last_seen_at` | C9. 토큰은 해시만 저장. 예비교사 7일·관리자 12시간은 서버가 넣는다 |
| `ai_settings` | `role` PK(행 3개), `provider` check, `key_*` nullable | 3단계 전에는 키 없음. 행 3개는 시드가 넣는다 |
| `audit_log` | `actor_id` nullable(`on delete set null`) | 서버 CLI 초기화는 actor 없음. action 목록은 지도 fog |
| `schema_migrations` (신규) | `version text pk, name, applied_at` | 아래 3절 |

공통: `id uuid default gen_random_uuid()`, `created_at`·`updated_at timestamptz default now()`, `set_updated_at()` before-update 트리거. 모든 enum 성격 컬럼은 `text + check` (Postgres enum 타입은 값 추가가 마이그레이션 부담). FK: `users` 삭제 → `group_members`·`sessions`(→`turns`)·`auth_sessions` cascade(USR-1), `scenarios` 삭제 → `scenario_translations`·`group_scenarios` cascade, **`sessions.scenario_id`는 restrict**(기록이 있는 시나리오는 삭제 불가 — 가정, 4절).

인덱스: `users(lower(nickname))`, `users((true)) where role='admin'`, `group_members(user_id)`, `group_scenarios(scenario_id)`(PK 가 `group_id` 선행), `sessions(user_id, started_at desc)`, `sessions(scenario_id)`, `turns(session_id, seq)`(unique), `auth_sessions(user_id)`, `audit_log(created_at desc)`. `concurrently` 없음.

## 2. 예비교사 읽기 경로와 RLS (ADR-0003 그대로)

- `scenarios_public` = `scenarios` − `internal` − `compiled_prompt` + **활성 `lang` 판 번역의 공개 컬럼**(`name, description, problem, chars, greet, elicit`)을 `left join`. `aha`·`t1~t3`·`confused`·`misconceptions`는 학생·멘토 대사라 뷰에 없고 서버가 발화로만 내보낸다. `with (security_invoker = true)`. 예비교사 API 응답 타입은 이 뷰의 컬럼 집합에서 파생한다(ADR-0003 Consequences).
- `teacher_scenarios(p_user_id uuid) returns setof scenarios_public`: `status='published' ∧ exists(group_scenarios ⋈ group_members)`, `language sql stable security invoker set search_path = public`, `name` 순.
- RLS: 12개 테이블 모두 `enable row level security`, 정책 0개. anon/authenticated에서 스키마 usage·전 테이블·시퀀스·함수 REVOKE + `alter default privileges … revoke`(postgres 가 이후 만드는 객체도 자동 GRANT 안 됨 — 점검 6단계가 확인). `teacher_scenarios`·`set_updated_at`은 PUBLIC EXECUTE 도 REVOKE. service_role·postgres 는 손대지 않는다.

## 3. 번호 규칙과 기록 테이블 (2단계 `deploy.sh` 계약)

- 파일명 `NNNN_<name>.sql`, 4자리 0패딩 순번. 정렬 순서 = 적용 순서. 파일 하나 = 트랜잭션 하나.
- 적용 명령: `psql "$SUPABASE_DB_URL" --single-transaction -v ON_ERROR_STOP=1 -f db/migrations/NNNN_x.sql` (Direct 5432 또는 Session pooler, Transaction pooler 금지 — 조사 티켓 5항).
- 각 파일은 **자기 보호**한다: 맨 앞 `do $$ … raise exception 'migration NNNN already applied'` 가드, 맨 끝 `insert into schema_migrations`. 그래서 `deploy.sh`는 순서대로 전부 실행만 하면 되고(이미 적용된 파일은 롤백되어 종료코드 ≠ 0), 미적용분만 돌리려면 `select version from schema_migrations`로 걸러 낸다. 기록 테이블은 `supabase_migrations.schema_migrations`가 아니라 자체 `public.schema_migrations`다(CLI 호환은 미확인이라 의존하지 않음, 조사 5항).
- 0001 은 `create table if not exists schema_migrations`로 시작하므로 빈 DB·기존 DB 어느 쪽에서도 같은 파일이 동작한다. 멱등 DDL(`if not exists`)은 그 한 줄뿐이고 나머지는 가드가 막는다.
- 역할(anon/authenticated/service_role)은 Supabase 가 만든다고 전제한다. 점검 스크립트가 흉내 내는 것 외에 마이그레이션은 역할을 만들지 않는다.

## 4. 채택한 추천안 (사용자 일괄 승인) · 가정

1. **SQL 한 파일, 주석이 PRD 6절 항목을 가리킴, 시드는 `db/seed/`** — 티켓 본문 추천 그대로.
2. **`compiled_prompt jsonb` 1개**(컬럼 3개 대신) — `compileScenario` 반환형과 1:1, 뷰에서 뺄 컬럼이 하나, 이름 유지로 문서 참조 보존.
3. **`sessions.progress jsonb {"mis": int[]}` + `counts jsonb` 유지 + `goal_reached bool`** — 티켓 6 관찰 그대로. 회전 인덱스는 저장하지 않는다.
4. **진행 중 턴 표시 = `sessions.turn_started_at`** — null 이 아니면 409(C8). 서버 죽음으로 남은 값의 해제 규칙은 fog("LLM 호출 실패·재시도 시 화면 동작")에 붙인다.
5. **로그인 = `auth_sessions`(해시 토큰, `realm`)** — C9·AUTH-3. 만료 행 정리는 서버 스케줄러(2단계).
6. **enum 은 `text + check`** — 값 추가가 ALTER 한 줄.
7. **`scenarios_public`에 활성 언어판 공개 컬럼을 조인** — 예비교사 읽기가 "뷰 + 함수 두 객체만" 거친다는 ADR-0003 4항을 지키려면 번역 공개 컬럼도 뷰 안에 있어야 한다.
8. **가정: `sessions.scenario_id on delete restrict`** — PRD 에 규정 없음. 기록이 있는 시나리오의 삭제 UX(차단 vs 보관 처리)는 API 계약 티켓에서 확정.
9. **가정: `sessions.report jsonb`** — 티켓 14 추천안(종료 시 1회 저장)과 맞춘 선반영. 14가 재계산 방식을 택하면 컬럼만 지운다.
10. **가정: `scenario_translations.desc` → `description`** — 예약어 회피. 목업·PRD 의 `desc` 키는 API 스키마에서 `description`으로 매핑.

## 5. 알려진 한계 · 다른 티켓으로

- `classification` 문구가 언어 공유 컬럼인 한계(티켓 9)는 주석으로만 남겼다.
- `max_turns`(기본 40, PRD 11절)는 컬럼이 아니라 서버 환경변수로 본다. 시나리오별 상한이 필요해지면 `scenarios`에 컬럼 추가.
- PRD 7절 4단계 스모크는 anon 키 → Data API 호출로 해야 한다(ADR-0003). psql 로는 BYPASSRLS 라 검증이 안 된다.
