-- 0001_init.sql — ReMath 초기 스키마 (PRD 6절 + 지도 C8·C9·C11, ADR-0002·ADR-0003)
--
-- 적용 전제: `psql --single-transaction -v ON_ERROR_STOP=1 -f` 로 postgres 역할이 번호 순으로 실행(조사 티켓 5항).
--   - 파일 하나 = 트랜잭션 하나. 실패하면 전부 롤백된다. 그래서 `create index concurrently` 금지.
--   - 각 파일은 맨 앞에서 "이미 적용됨"을 검사하고 맨 끝에서 schema_migrations 에 자기 버전을 기록한다.
--   - 시드(관리자 계정·분류 세트·이모지 프리셋·샘플)는 여기 없다. db/seed/ (지도 C12).
-- 역할 전제: anon / authenticated / service_role 은 Supabase 가 만든다. 이 파일은 만들지 않는다.

-- 0. 마이그레이션 기록 -----------------------------------------------------------
create table if not exists schema_migrations (
  version    text primary key,          -- 파일명 앞 4자리, '0001'
  name       text not null,             -- 파일명 뒷부분, 'init'
  applied_at timestamptz not null default now()
);
do $$ begin
  if exists (select 1 from schema_migrations where version = '0001') then
    raise exception 'migration 0001 already applied';
  end if;
end $$;

-- 공통: updated_at 자동 갱신 트리거 함수 (PRD 6절 "모든 테이블은 created_at, updated_at")
create function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- 1. 사용자·그룹 ------------------------------------------------------------------
-- PRD 6절 users. 개인정보 컬럼 없음. 닉네임 규칙(2~16자·문자 집합·@·7자리 숫자)은 서버 zod 가 검사한다.
create table users (
  id            uuid primary key default gen_random_uuid(),
  nickname      text not null,
  password_hash text not null,                                   -- argon2id
  role          text not null default 'teacher' check (role in ('teacher', 'admin')),
  pw_updated_at timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index users_nickname_key on users (lower(nickname));   -- PRD 9절 "중복 불가(대소문자 무시)"
create unique index users_single_admin on users ((true)) where role = 'admin';  -- AUTH-5 관리자 1개 고정
create trigger users_updated_at before update on users for each row execute function set_updated_at();

-- PRD 6절 groups
create table groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger groups_updated_at before update on groups for each row execute function set_updated_at();

-- PRD 6절 group_members (복합 PK). 연결 테이블은 id·updated_at 을 두지 않는다.
create table group_members (
  group_id   uuid not null references groups (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_idx on group_members (user_id);

-- 2. 시나리오 ------------------------------------------------------------------------
-- PRD 6절 scenarios. internal·compiled_prompt 는 서버 전용(ADR-0003 4항): 예비교사 경로는 scenarios_public 뷰만 본다.
create table scenarios (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  status          text not null default 'draft' check (status in ('draft', 'published')),
  lang            text not null default 'en' check (lang in ('ko', 'en')),   -- 챗봇 언어(활성 판). 기본 en(PRD 11절 확정)
  student_prefix  text not null default '',                                   -- 이모지 프리셋(SCN-6)
  mentor_prefix   text not null default '',                                   -- UI 전용, 프롬프트 미주입(티켓 9)
  grade           text not null default '',
  -- {baseline, drawing, reasoning, never, goal, prog, misconceptions: [{text}]} — 티켓 9 플레이스홀더 출처 표
  internal        jsonb not null default '{}',
  -- {leverage: [{name, desc, ex}], object: [{name, desc, ex}]}. 레버리지 0개면 분류·분석 생략(SCN-3).
  -- 알려진 한계(티켓 9): 분류명·설명·예시는 언어 텍스트인데 언어 공유 컬럼이다. 챗봇 언어를 바꿔도 그대로 남는다(PRD 6절·목업 동일).
  classification  jsonb not null default '{"leverage": [], "object": []}',
  -- 게시 시 활성 lang 판으로 컴파일한 {student, analysis|null, mentor} (ADR-0001·C11). 초안은 null. PRD 의 text 1개를 jsonb 1개로 넓혔다.
  compiled_prompt jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (status = 'draft' or compiled_prompt is not null)   -- 게시 상태는 반드시 컴파일본을 가진다
);
create trigger scenarios_updated_at before update on scenarios for each row execute function set_updated_at();

-- PRD 6절 scenario_translations. 언어별 대사 세트, (scenario_id, lang) unique.
-- `desc` 는 SQL 예약어라 description 으로 둔다(유일한 PRD 컬럼명 변경).
create table scenario_translations (
  id             uuid primary key default gen_random_uuid(),
  scenario_id    uuid not null references scenarios (id) on delete cascade,
  lang           text not null check (lang in ('ko', 'en')),
  name           text not null default '',
  description    text not null default '',
  problem        text not null default '',
  chars          text not null default '',
  greet          text not null default '',
  aha            text not null default '',
  t1             text not null default '',       -- 멘토 트리거 텍스트: 주도권 빼앗기
  t2             text not null default '',       -- 도움 요청
  t3             text not null default '',       -- 도달점
  confused       jsonb not null default '[]',    -- string[] 혼란 대사(회전)
  elicit         jsonb not null default '[]',    -- string[] 빠른 질문 칩(CHAT-5)
  -- [{kw, h, c}] 오개념 순서 = internal.misconceptions 순서. kw 는 언어별 정규식 문자열 1개(무효 정규식이면 부분 문자열, ADR-0002)
  misconceptions jsonb not null default '[]',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (scenario_id, lang)
);
create trigger scenario_translations_updated_at before update on scenario_translations for each row execute function set_updated_at();

-- PRD 6절 group_scenarios — 접근 제어의 유일한 근거(GRP-2)
create table group_scenarios (
  group_id    uuid not null references groups (id) on delete cascade,
  scenario_id uuid not null references scenarios (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (group_id, scenario_id)
);
create index group_scenarios_scenario_idx on group_scenarios (scenario_id);

-- 3. 연습 세션·발화 -------------------------------------------------------------------
-- PRD 6절 sessions = 연습 세션(C10). 관리자 대화 테스트는 user_id = 관리자.
create table sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users (id) on delete cascade,      -- USR-1 사용자 삭제 시 기록도 삭제
  scenario_id     uuid not null references scenarios (id) on delete restrict, -- 기록이 있는 시나리오는 삭제 불가(가정, API 계약 티켓에서 확정)
  lang            text not null check (lang in ('ko', 'en')),                  -- 시작 시점의 챗봇 언어 스냅샷
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  goal_reached    boolean not null default false,                              -- ADR-0002
  counts          jsonb not null default '{}',                                 -- {"<leverage name>": n} 레버리지 누적
  progress        jsonb not null default '{"mis": []}',                        -- {"mis": int[]} 오개념별 교정 카운터 0..2 (ADR-0002)
  report          jsonb,                                                       -- 종료 시 1회 저장하는 분석 리포트(형태는 "세션 종료 리포트 JSON 스키마 결정")
  turn_started_at timestamptz,                                                 -- C8 진행 중 턴 표시. null 이 아니면 새 턴은 409
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index sessions_user_started_idx on sessions (user_id, started_at desc);  -- /practice/history, CSV 필터
create index sessions_scenario_idx on sessions (scenario_id);
create unique index sessions_one_active on sessions (user_id) where ended_at is null;  -- D-14 진행 중 세션 사용자당 1개(위반 → 409 session_active)
create trigger sessions_updated_at before update on sessions for each row execute function set_updated_at();

-- PRD 6절 turns — CSV 의 1행(C13). CSV 의 nickname·scenario 는 내보낼 때 조인한다.
create table turns (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions (id) on delete cascade,
  seq        integer not null,
  speaker    text not null check (speaker in ('teacher', 'student', 'mentor')),
  text       text not null,
  leverage   text,                                      -- 예비교사 발화에만, 분류 기준이 있을 때만
  object     text,
  trigger    smallint check (trigger between 1 and 3),  -- 멘토 발화에만: 1 주도권 빼앗기 / 2 도움 요청 / 3 도달점
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, seq)                              -- = 인덱스 turns(session_id, seq)
);
create trigger turns_updated_at before update on turns for each row execute function set_updated_at();

-- 4. 로그인 -------------------------------------------------------------------------
-- 지도 C9. 쿠키에는 불투명 토큰만, 여기엔 그 해시만. 예비교사 7일·관리자 12시간(PRD 9절)은 서버가 expires_at 으로 넣는다.
create table auth_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,
  realm        text not null check (realm in ('teacher', 'admin')),  -- AUTH-3 관리자 로그인은 /admin 에서만 발급, 두 로그인 분리
  token_hash   text not null unique,                                 -- sha256(token)
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index auth_sessions_user_idx on auth_sessions (user_id);
create trigger auth_sessions_updated_at before update on auth_sessions for each row execute function set_updated_at();

-- 5. AI 설정·감사 로그 ------------------------------------------------------------------
-- PRD 6절 ai_settings. role 이 PK(행 3개). 3단계 전에는 key_* 가 null.
create table ai_settings (
  role           text primary key check (role in ('student', 'mentor', 'analysis')),
  key_source     text not null default 'own' check (key_source in ('own', 'student', 'mentor', 'analysis')),
  provider       text check (provider in ('openai', 'anthropic', 'gemini')),
  key_ciphertext text,                                   -- AES-256-GCM, 서버만 복호. SQLite 백업에서 제외(PRD 7절)
  key_masked     text,                                   -- 접두어 + 끝 4자
  model          text,
  effort         text,                                   -- 허용값은 providers.json 이 (공급자, 모델)별로 정한다(티켓 3)
  key_added_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger ai_settings_updated_at before update on ai_settings for each row execute function set_updated_at();

-- PRD 6절 audit_log. 추가만 한다(updated_at·트리거 없음, 티켓 20). action 은 shared/src/api/schemas.ts 의 AuditAction 목록(티켓 20 §1).
create table audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid references users (id) on delete set null,   -- 서버 CLI(관리자 비밀번호 초기화)는 null
  action     text not null,
  target     text,                                            -- 대상 id 나 이름
  meta       jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_log_created_idx on audit_log (created_at desc);

-- 6. 예비교사용 시나리오 읽기 경로 (ADR-0003 4항) --------------------------------------------
-- scenarios 에서 internal·compiled_prompt 를 뺀 것 + 활성 챗봇 언어판의 공개 대사(name/description/problem/chars/greet/elicit).
-- aha·t1~t3·confused·misconceptions 는 학생·멘토 대사라 서버가 발화로만 내보낸다. 예비교사 API 응답 타입은 이 뷰의 컬럼 집합이다.
create view scenarios_public with (security_invoker = true) as
  select s.id, s.slug, s.status, s.lang, s.student_prefix, s.mentor_prefix, s.grade, s.classification,
         t.name, t.description, t.problem, t.chars, t.greet, t.elicit,
         s.created_at, s.updated_at
    from scenarios s
    left join scenario_translations t on t.scenario_id = s.id and t.lang = s.lang;

-- 예비교사가 볼 수 있는 시나리오: 게시됨 ∧ 소속 그룹에 할당됨. exists 라 중복 없음.
create function teacher_scenarios(p_user_id uuid) returns setof scenarios_public
  language sql stable security invoker set search_path = public as $$
  select p.*
    from scenarios_public p
   where p.status = 'published'
     and exists (select 1
                   from group_scenarios gs
                   join group_members gm on gm.group_id = gs.group_id
                  where gs.scenario_id = p.id and gm.user_id = p_user_id)
   order by p.name;
$$;

-- 턴 원자성 (E-18, 가정 O-2). Data API 는 트랜잭션이 없어서 서버가 rpc 로 부른다. 함수 호출 1번 = 문장 1개 = 전부 아니면 전무.
-- 인자 이름은 rpc 의 JSON 키라 E-18 그대로 두고, 본문에서는 컬럼과 겹치지 않게 함수 이름으로 한정한다.
-- record_turn: 이번 턴 발화 n행(seq 는 서버가 매김) insert + sessions 상태 갱신 + turn_started_at 해제. 종료 턴은 turns = '[]' 에 ended_at·report.
create function record_turn(session_id uuid, turns jsonb, progress jsonb, counts jsonb, goal_reached boolean,
                            ended_at timestamptz, report jsonb) returns void
  language sql volatile security invoker set search_path = public as $$
  insert into turns (session_id, seq, speaker, text, leverage, object, trigger)
    select record_turn.session_id, t.seq, t.speaker, t.text, t.leverage, t.object, t.trigger
      from jsonb_to_recordset(record_turn.turns) as t(seq integer, speaker text, text text, leverage text, object text, trigger smallint);
  update sessions
     set progress = record_turn.progress, counts = record_turn.counts, goal_reached = record_turn.goal_reached,
         ended_at = record_turn.ended_at, report = record_turn.report, turn_started_at = null
   where id = record_turn.session_id;
$$;

-- claim_turn: turn_started_at 이 null 이거나 timeout_ms 를 넘긴 고아(티켓 19 §3)일 때만 now() 로 잡고 true. 동시 두 요청은 행 잠금 뒤 조건을 다시 봐서 하나만 true.
create function claim_turn(session_id uuid, timeout_ms integer) returns boolean
  language sql volatile security invoker set search_path = public as $$
  with claimed as (
    update sessions set turn_started_at = now()
     where id = claim_turn.session_id
       and (turn_started_at is null or turn_started_at < now() - make_interval(secs => claim_turn.timeout_ms / 1000.0))
    returning 1)
  select exists (select 1 from claimed);
$$;

-- 7. RLS 2차 방어 = anon/authenticated(Data API 직접 접근) 전면 거부 (ADR-0003 1·2항) --------------
-- RLS on + 정책 0개. service_role·postgres 는 BYPASSRLS 라 영향 없음. 서버의 접근 제어는 API 검사가 유일하다.
alter table schema_migrations      enable row level security;
alter table users                  enable row level security;
alter table groups                 enable row level security;
alter table group_members          enable row level security;
alter table scenarios              enable row level security;
alter table scenario_translations  enable row level security;
alter table group_scenarios        enable row level security;
alter table sessions               enable row level security;
alter table turns                  enable row level security;
alter table auth_sessions          enable row level security;
alter table ai_settings            enable row level security;
alter table audit_log              enable row level security;

-- Supabase 기본 GRANT(스키마·전 테이블·시퀀스·함수)와 postgres 의 default privileges 를 anon/authenticated 에서 제거.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke usage on schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
revoke execute on function teacher_scenarios(uuid) from public;
revoke execute on function set_updated_at()        from public;
revoke execute on function record_turn(uuid, jsonb, jsonb, jsonb, boolean, timestamptz, jsonb) from public;
revoke execute on function claim_turn(uuid, integer) from public;
-- PG15+ 의 public 스키마는 PUBLIC 에 usage 를 준다(anon 도 PUBLIC 이라 위 usage REVOKE 만으로는 남는다). 그래서 이 역할이 이후 만드는 함수의
-- 기본 PUBLIC EXECUTE 도 끈다. 이 전역 기본값은 `in schema` 로는 지울 수 없다.
alter default privileges revoke execute on functions from public;

-- 8. 기록 ---------------------------------------------------------------------------
insert into schema_migrations (version, name) values ('0001', 'init');
