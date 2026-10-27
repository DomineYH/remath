# Supabase RLS · 뷰 · service role 동작 조사 (ticket #2)

조사일: 2026-10-27. 1차 출처(supabase.com/docs, postgresql.org/docs, supabase GitHub 소스)만 사용했다. 확인 못 한 항목은 **미확인**으로 표시.

## 요약

1. service role(secret key)은 `service_role` Postgres 역할로 접속하며, 이 역할은 `BYPASSRLS` 속성을 가져 **모든 RLS 정책을 항상 건너뛴다**. 단, 요청에 사용자 access token이 함께 실리면 그 사용자의 역할·정책으로 실행된다.
2. 뷰는 기본적으로 **뷰 소유자**(보통 `postgres`, BYPASSRLS 보유)의 권한·정책으로 기반 테이블을 읽어 RLS를 사실상 우회한다. Supabase 공식 권장은 PG15+ `with (security_invoker = true)`.
3. 서버가 service role로 접속하면서 "요청 사용자"를 정책에 전달하는 공식 경로는 없다. 트랜잭션 안에서 `set local role authenticated` + `set_config('request.jwt.claims', …, true)`로 PostgREST를 흉내내는 방법이 Supabase 테스트 문서에 있으나, `service_role`은 BYPASSRLS라 **별도 NOBYPASSRLS 로그인 역할**이 있어야 RLS가 실제로 걸린다.
4. 컬럼 거부는 컬럼 권한(`REVOKE`/`GRANT (col)`)과 뷰 분리 둘 다 가능하지만, Supabase는 컬럼 권한을 "대부분의 사용자에게 권장하지 않음"으로 표시하고 `select *`가 실패하는 부작용을 경고한다. PRD의 `scenarios_public` 뷰 분리가 기본이고, security_invoker 뷰를 쓰려면 기반 테이블에도 (허용 컬럼만) SELECT를 줘야 한다.
5. CLI 없이 적용하려면 `psql --single-transaction -v ON_ERROR_STOP=1 -f …`(Supabase 백업/복구 문서가 쓰는 형태)로 번호 순 실행하면 된다. `supabase db push`는 `supabase_migrations.schema_migrations(version, name, statements)`에 기록을 남기고 미적용분만 실행하며, 소스상 파일 단위 `BEGIN/COMMIT`은 열지 않는다.

## 질문별 답

### 1. service role 키는 RLS를 우회하는가, 어떤 조건에서

- Supabase API 키 문서: "Secret keys authorize access to your project's data through the built-in `service_role` Postgres role." / "It also has the `BYPASSRLS` attribute, so it skips every Row Level Security policy you attach." / "Policies never apply to a secret key, because `service_role` has the `BYPASSRLS` attribute." [S1]
- 역할 정의 소스(supabase/postgres 초기 스키마): `create role service_role nologin noinherit bypassrls;`, `grant service_role to authenticator;` [S10]
- PostgreSQL: "Superusers and roles with the `BYPASSRLS` attribute always bypass the row security system when accessing a table. Table owners normally bypass row security as well, though a table owner can choose to be subject to row security with `ALTER TABLE ... FORCE ROW LEVEL SECURITY`." [P1]
- 예외 조건(Supabase RLS 문서): "A secret key bypasses RLS only when the request carries no user access token. If the request carries one, it runs under the RLS policies of that signed-in user, even when the client library was initialized with a secret key." [S2] — Data API(PostgREST) 경로에서 `Authorization: Bearer <user jwt>`를 붙이면 JWT의 `role` claim으로 역할이 바뀌기 때문이다(PostgREST: "PostgREST will switch to the database role with that name for the duration of the HTTP request." [PR1]).
- `postgres` 역할(대시보드·직접 psql 접속)도 BYPASSRLS다: `ALTER ROLE postgres NOSUPERUSER CREATEDB CREATEROLE LOGIN REPLICATION BYPASSRLS;` [S11]. psql로 `postgres`로 접속해도 RLS는 적용되지 않는다.
- 결론: 우회 여부는 "키"가 아니라 **세션의 현재 Postgres 역할이 BYPASSRLS인지**로 결정된다. `service_role`, `postgres`는 항상 우회. `row_security = off` 설정은 우회가 아니라 "정책이 결과를 걸러내면 에러"를 내는 안전장치다 [P1].

### 2. 뷰(`scenarios_public`)와 RLS: definer vs security_invoker

- PostgreSQL CREATE VIEW: "By default, access to the underlying base relations referenced in the view is determined by the permissions of the view owner." / "If any of the underlying base relations has row-level security enabled, then by default, the row-level security policies of the view owner are applied ... However, if the view has `security_invoker` set to `true`, then the policies and permissions of the invoking user are used instead, as if the base relations had been referenced directly from the query using the view." [P2]
- Supabase RLS 문서: "Views bypass RLS by default because they are usually created with the `postgres` user." / "A view over a protected table hands out every row its policies were meant to withhold, so a view needs the same attention as a table." 권장 SQL: `create view <VIEW_NAME> with(security_invoker = true) as select <QUERY>` (PG15+). PG14 이하: "protect your views by revoking access from the `anon` and `authenticated` roles, or by putting them in an unexposed schema." [S2]
- Supabase Views 문서도 같은 형태를 권장: `alter view <view name> set (security_invoker = true);` / `create view <view name> with(security_invoker=true) as (...)` [S3]
- PostgREST 문서(PG15 미만 대안): 뷰 소유자를 `CREATE ROLE api_views_owner NOSUPERUSER NOBYPASSRLS;`로 만든 뒤 `ALTER VIEW ... OWNER TO api_views_owner;` [PR2]
- 함의: `scenarios_public`을 `postgres`가 기본 옵션으로 만들면 **`scenarios`의 RLS 정책이 적용되지 않고** 모든 행이 노출된다. 정책은 테이블에만 걸 수 있으므로 뷰는 `security_invoker = true`로 만들고, `scenarios` 테이블에 `anon`/`authenticated`용 SELECT 정책(published + 그룹 소속)을 두어야 뷰를 통해 그 정책이 적용된다. 또한 security_invoker 뷰는 호출자가 **뷰와 기반 테이블 양쪽에** 권한이 있어야 한다("the user of a security invoker view must have the relevant permissions on the view and its underlying base relations." [P2]) — `scenarios` 테이블 SELECT를 anon/authenticated에 전혀 주지 않으면 security_invoker 뷰도 못 읽는다(4번 참조).

### 3. service role로 접속하면서 "요청한 사용자"를 정책에 전달하는 선택지

전제: Supabase의 `auth.uid()`는 `request.jwt.claim.sub` 또는 `request.jwt.claims` JSON의 `sub`를 읽는 SQL 함수다 — `coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid` [S12]. `auth.jwt()`는 `request.jwt.claim`/`request.jwt.claims` 설정을 jsonb로 반환한다 [S13]. 이 설정은 PostgREST가 트랜잭션 범위로 넣는다("PostgREST uses settings tied to the transaction lifetime", 읽기는 `current_setting('request.jwt.claims', true)` [PR3]). PostgreSQL은 점(.)이 들어간 임의의 두 부분 이름을 설정으로 받아들인다("PostgreSQL will accept a setting for any two-part parameter name." [P9]).

| 선택지 | 방법 | 제약 |
| --- | --- | --- |
| (a) `set_config` + `set local role` 흉내 | 트랜잭션 안에서 `set local role authenticated; select set_config('request.jwt.claims', '{"sub":"…","role":"authenticated"}', true);` 후 쿼리. Supabase RLS 문서의 정책 테스트가 쓰는 형태(`set local role anon;` / `set local request.jwt.claim.sub = '…';`) [S2], 성능 문서는 `set session role authenticated; set request.jwt.claims to '{…}'` [S4] | ① 접속 역할이 `service_role`/`postgres`면 역할을 바꿔야만 RLS가 걸린다. `SET ROLE`은 "The current session user must have the `SET` option for the specified role_name" [P3]이 필요하며, 바꾼 뒤의 `current_user`로 정책이 검사된다. `postgres`는 `grant anon, authenticated, service_role to postgres;` [S22]로 멤버십이 있어 `set role authenticated`가 가능하지만, `service_role`→`authenticated` 멤버십은 소스에서 찾지 못함 — **미확인**. ② 같은 트랜잭션·같은 커넥션에서 실행해야 한다: `SET LOCAL`은 "takes effect for only the current transaction" [P4], `set_config(..., true)`도 "the new value will only apply during the current transaction" [P5]. Transaction-mode pooler(6543)는 `set` 등 세션 상태를 트랜잭션 간 보존하지 않는다 [S7]. ③ `RESET ROLE`/`SET ROLE NONE`은 "can be executed by any user" [P3]이므로 SQL 주입 시 권한 복귀 경로가 된다. |
| (b) 전용 Postgres 로그인 역할 | `create role remath_app login nobypassrls` + 정책이 이 역할을 대상으로 하거나 `grant authenticated to remath_app`. 서버는 이 역할로 드라이버 접속 후 (a)의 `set_config`로 `sub` 전달. Supabase 역할 문서는 `create role`로 로그인 역할·계층 생성을 기술 [S5] | 역할 자체가 RLS 대상이므로 **실제 2차 방어**가 된다. 대신 Data API(PostgREST)가 아닌 **직접 DB 접속**(Direct 5432 또는 Session pooler)이 필요하고 [S7], 테이블·시퀀스 GRANT를 직접 관리해야 한다. Supabase 역할 문서는 역할을 앱 접근 제어용으로 쓰는 것을 권장하지 않고 RLS를 쓰라고 안내한다 [S5]. `ai_settings`·`audit_log`처럼 RLS 밖에서 다뤄야 하는 작업은 별도 커넥션(service role 또는 BYPASSRLS 역할)이 필요. |
| (c) 커스텀 JWT 서명 → Data API | 서버가 `{"role":"authenticated","sub":"<user uuid>"}`를 프로젝트 서명키로 서명해 `Authorization: Bearer`로 전달. PostgREST는 `role` claim의 역할로 `SET LOCAL ROLE` [PR1]; Supabase: "A secret key bypasses RLS only when the request carries no user access token" [S2] | 프로젝트 **서명키를 서버가 보유**해야 한다. JWT 서명키 문서: 레거시 공유 secret은 "No longer recommended", "You can only extract the legacy JWT secret"; 새 시스템은 "you can create a new JWT signing key by importing a private key or setting a shared secret yourself" [S8]. 직접 민팅한 토큰에 대해 `supabase.auth.getClaims()`는 "meant to be used only with JWTs issued by Supabase Auth" [S9]. Third-party auth 경로는 asymmetric 서명 + `kid` 헤더 필수 [S14]. 요청마다 토큰 생성 비용과 키 노출 범위가 단점. |
| (d) `SET ROLE`만 (sub 전달 없음) | `set local role anon` 등 | `auth.uid()`가 null이 되어 "본인 행" 정책은 못 쓴다. 역할 단위(anon/authenticated) 정책만 검증 가능. |

Supabase 문서는 위 중 어느 것도 "서버에서 사용자 흉내" 용도로 공식 권장하지 않는다(테스트 용도로만 기술). **공식 권장 부재**로 기록한다.

### 4. anon 키로 `scenarios.internal`만 거부하는 표준 패턴

- 컬럼 권한: Supabase Column Level Security 문서 예시 `revoke update on table public.posts from authenticated; grant update (title, content) on table public.posts to authenticated;` / `revoke update (title) on table public.posts from authenticated;` [S6]. PostgreSQL GRANT: "A user may perform `SELECT`, `INSERT`, etc. on a column if they hold that privilege for either the specific column or its whole table. Granting the privilege at the table level and then revoking it for one column will not do what one might wish: the table-level grant is unaffected by a column-level operation." [P6]; REVOKE: "if a role has been granted privileges on a table, then revoking the same privileges from individual columns will have no effect." [P7] → **테이블 SELECT를 먼저 REVOKE하고 허용 컬럼만 GRANT** 해야 한다.
- 컬럼 권한의 부작용(Supabase): "Restricted roles cannot use the wildcard operator (`*`) on the affected table." / "All operations (insert, update, delete) as well as using `select *` will fail." / "We do not recommend using column-level privileges for most users." [S6]
- 뷰 분리: 2번과 같이 `scenarios_public`(internal·compiled_prompt 제외) 뷰를 `security_invoker = true`로 만들고 뷰에 `grant select ... to anon, authenticated`. Supabase Views 문서의 권한 예시는 뷰에 직접 GRANT하는 형태(`grant all on table transcripts to authenticated;`) [S3].
- 두 방식의 조합: security_invoker 뷰는 호출자가 기반 테이블 권한도 필요하다 [P2]. 따라서
  - **패턴 A(security_invoker 뷰 + 컬럼 GRANT)**: `scenarios`는 `revoke select on scenarios from anon, authenticated` 후 `grant select (id, slug, status, lang, …) on scenarios to anon, authenticated`(internal·compiled_prompt 제외) + RLS 정책 + security_invoker 뷰. 테이블 직접 `select *`는 실패, 뷰는 정상. 컬럼 목록이 GRANT와 뷰 정의 두 곳에 중복된다.
  - **패턴 B(definer 뷰, 테이블 미노출)**: `scenarios`에 anon/authenticated SELECT를 아예 주지 않고, 뷰 소유자를 NOBYPASSRLS 역할로 두거나 [PR2] 뷰 WHERE에 `status = 'published' and exists (select 1 from group_scenarios ... auth.uid())`를 직접 쓴다. 기반 테이블 RLS가 뷰에 적용되지 않으므로 접근 조건을 뷰에 다시 써야 한다(이중 관리).
  - 어느 쪽이든 PRD 7절 4단계 스모크("anon 키로 `scenarios.internal` 읽기 거부")는 `scenarios` 테이블 SELECT 미부여 또는 컬럼 미부여로 충족된다. 뷰에 `internal`이 없으면 뷰 경로로는 읽을 수 없다.

### 5. Supabase CLI 없이 SQL 파일을 번호 순으로 적용하는 방법

- `supabase db push`: "Pushes all local migrations to a remote database." 기록 테이블은 `supabase_migrations.schema_migrations`이며 첫 실행 시 생성, "Subsequent pushes will skip migrations that have already been applied." 플래그 `--db-url`, `--dry-run`, `--include-all`, `--include-roles`, `--include-seed` [S15]. 배포 문서: "Migration files are applied in timestamp order" / "it compares your local `supabase/migrations` folder against that table and runs only the ones not yet applied, in order." / "`migration repair` updates the tracking table only — it does not apply or revert any SQL." / "Using the Dashboard's SQL editor or Table Editor on your remote database bypasses the migration history." [S16]
- 기록 테이블 정의(CLI 소스 `history.go`): `CREATE SCHEMA IF NOT EXISTS supabase_migrations`, `CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)`, `ADD COLUMN IF NOT EXISTS statements text[]`, `ADD COLUMN IF NOT EXISTS name text`, `INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)` [S17]
- 적용 방식(CLI 소스 `file.go`, `apply.go`): 파일을 문장 단위로 분리해 하나의 pgconn batch로 보내고, 기록 INSERT를 같은 batch 끝에 넣는다. `CREATE INDEX CONCURRENTLY` 등 파이프라인 비호환 문장은 batch를 flush 후 단독 실행. `ApplyMigrations`는 파일마다 `RESET ALL` 후 `ExecBatch`를 호출하며 소스에 **`BEGIN`/`COMMIT` 호출이 없다**(에러 시 이전 파일은 적용된 채 중단) [S18][S19]. pgconn batch가 암묵적 트랜잭션으로 묶이는지는 **미확인**.
- 생 `psql`: `-f` "Read commands from the file filename ... This option can be repeated"; `-1/--single-transaction` "causes psql to issue a `BEGIN` command before the first such option and a `COMMIT` command after the last one ... If any of the commands fails and the variable `ON_ERROR_STOP` was set, a `ROLLBACK` command is sent instead." 단 "if an individual command cannot be executed inside a transaction block, specifying this option will cause the whole transaction to fail." (예: `CREATE INDEX CONCURRENTLY`) [P8]. Supabase 백업/복구 문서가 이 형태를 쓴다: `psql --single-transaction --variable ON_ERROR_STOP=1 --file roles.sql --file schema.sql ... --dbname [CONNECTION_STRING]` [S20].
- 접속: 마이그레이션·pg_dump는 Direct connection(`db.[ref].supabase.co:5432`, IPv6 또는 IPv4 add-on) 권장, Session pooler(5432, IPv4)도 prepared statement 지원, Transaction pooler(6543)는 세션 상태 미보존 [S7].
- 차이 정리: `psql`은 **기록 테이블·중복 적용 방지·순서 보장이 없다**. `ls db/migrations/*.sql | sort`로 순서를 만들고 멱등성(`if not exists`) 또는 자체 기록 테이블을 둬야 한다. `supabase_migrations.schema_migrations`에 같은 형식으로 직접 INSERT하면 CLI(`supabase migration list/repair`)와 호환될 것으로 보이나 공식 문서가 보장하는 계약은 아니다 — **미확인**. CLI는 `--db-url`로 어떤 Postgres에도 적용 가능하므로 `supabase migration up --db-url` [S21]도 대안이다.

## PRD 6절 RLS 규칙에 대한 함의

1. "서버는 service role, RLS는 2차 방어"는 **서버 경로에서는 성립하지 않는다**. service role은 항상 BYPASSRLS이므로 RLS는 anon/authenticated 키로 들어오는 클라이언트 직접 접근(Data API)에 대한 방어선일 뿐이다. 서버 쿼리의 접근 제어는 API 검사가 유일한 방어다. 서버 경로에도 2차 방어를 두려면 3번 (b) 전용 NOBYPASSRLS 역할 + 직접 DB 접속이 필요하다.
2. `scenarios_public`은 `with (security_invoker = true)`로 만들고, `scenarios`에 anon/authenticated SELECT 정책(published + group_scenarios 조인)과 컬럼 단위 GRANT(internal·compiled_prompt 제외)를 둔다. 뷰에만 GRANT하면 security_invoker 뷰는 읽히지 않는다.
3. `sessions`·`turns` "본인 것만" 정책은 `auth.uid()`에 의존하므로 Supabase Auth JWT가 있는 요청에서만 동작한다. PRD는 닉네임+argon2 자체 인증이라 Supabase Auth JWT가 없다 → 클라이언트 직접 접근을 아예 막는 것(anon/authenticated에 GRANT 없음 + RLS on, 정책 0개)이 정책 작성보다 단순하고 안전하다.
4. `ai_settings`·`audit_log`: anon/authenticated에 GRANT를 주지 않고 RLS를 켠 채 정책 0개로 둔다("Once RLS is enabled, no data is accessible through the API when using a publishable key, until you create policies." [S2]).
5. 7절 2단계 마이그레이션은 `psql --single-transaction -v ON_ERROR_STOP=1`로 번호 순 적용하되 `CREATE INDEX CONCURRENTLY`를 쓰지 않는다. 스모크 4단계는 `postgres`로 psql 접속이 아니라 **anon 키 → Data API**로 `scenarios.internal`을 읽어야 의미가 있다(psql `postgres`는 BYPASSRLS).

## 출처

Supabase 문서
- [S1] https://supabase.com/docs/guides/api/api-keys
- [S2] https://supabase.com/docs/guides/database/postgres/row-level-security
- [S3] https://supabase.com/docs/guides/database/views
- [S4] https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv
- [S5] https://supabase.com/docs/guides/database/postgres/roles
- [S6] https://supabase.com/docs/guides/database/postgres/column-level-security
- [S7] https://supabase.com/docs/guides/database/connecting-to-postgres
- [S8] https://supabase.com/docs/guides/auth/signing-keys
- [S9] https://supabase.com/docs/guides/auth/jwts
- [S14] https://supabase.com/docs/guides/auth/third-party/overview
- [S15] https://supabase.com/docs/reference/cli/supabase-db-push
- [S16] https://supabase.com/docs/guides/deployment/database-migrations
- [S20] https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore
- [S21] https://supabase.com/docs/reference/cli/supabase-migration-up

Supabase GitHub 소스
- [S10] https://github.com/supabase/postgres/blob/802e6a10d46963f690ef0766a7d55c29150678c2/migrations/db/init-scripts/00000000000000-initial-schema.sql
- [S11] https://github.com/supabase/postgres/blob/802e6a10d46963f690ef0766a7d55c29150678c2/migrations/db/migrations/10000000000000_demote-postgres.sql
- [S12] https://github.com/supabase/auth/blob/master/migrations/20220224000811_update_auth_functions.up.sql
- [S13] https://github.com/supabase/auth/blob/master/migrations/20220531120530_add_auth_jwt_function.up.sql
- [S17] https://github.com/supabase/cli/blob/11559a9d37d5f26e8682a9d85df0d6119e6bed29/apps/cli-go/pkg/migration/history.go
- [S18] https://github.com/supabase/cli/blob/11559a9d37d5f26e8682a9d85df0d6119e6bed29/apps/cli-go/pkg/migration/file.go
- [S19] https://github.com/supabase/cli/blob/11559a9d37d5f26e8682a9d85df0d6119e6bed29/apps/cli-go/pkg/migration/apply.go
- [S22] https://github.com/supabase/postgres/blob/802e6a10d46963f690ef0766a7d55c29150678c2/migrations/db/migrations/20230201083204_grant_auth_roles_to_postgres.sql

PostgreSQL 문서
- [P1] https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- [P2] https://www.postgresql.org/docs/current/sql-createview.html
- [P3] https://www.postgresql.org/docs/current/sql-set-role.html
- [P4] https://www.postgresql.org/docs/current/sql-set.html
- [P5] https://www.postgresql.org/docs/current/functions-admin.html
- [P6] https://www.postgresql.org/docs/current/sql-grant.html
- [P7] https://www.postgresql.org/docs/current/sql-revoke.html
- [P8] https://www.postgresql.org/docs/current/app-psql.html
- [P9] https://www.postgresql.org/docs/current/runtime-config-custom.html

PostgREST 문서(Supabase Data API 구현체)
- [PR1] https://docs.postgrest.org/en/stable/references/auth.html
- [PR2] https://docs.postgrest.org/en/stable/explanations/db_authz.html
- [PR3] https://docs.postgrest.org/en/stable/references/transactions.html
