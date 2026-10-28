-- 0004_admin_atomic.sql — 관리자 쓰기의 원자성 (#43 rev 2, #35 O-2·0002와 같은 원칙)
--
-- 적용 전제는 0001과 같다: `psql --single-transaction -v ON_ERROR_STOP=1 -f`, 맨 앞 가드, 맨 끝 schema_migrations 기록.
-- 0001·0002 뒤에 적용한다. 0003(#42)과는 서로 독립이다.
-- Data API(PostgREST)는 요청 사이에 트랜잭션을 묶을 수 없으므로 여러 행에 걸친 관리자 쓰기를 함수 하나(= rpc 한 번 = 트랜잭션 하나)로 만든다:
--   - save_scenario: 시나리오 행(항상 draft + compiled_prompt null) + 번역 2행. 생성도 같은 함수라 번역 없는 시나리오가 생기지 않는다.
--   - publish_scenario: 검수·컴파일할 때 읽은 updated_at 이 그대로일 때만 게시. save_scenario 는 시나리오 행을 늘 UPDATE 하므로
--     (번역만 바뀌어도) set_updated_at 트리거가 updated_at 을 옮긴다. 그래서 검수하지 않은 내용은 게시되지 않는다.
--   - set_group_links: 그룹 구성원·시나리오 두 연결 집합을 검증 후 한 번에 치환. 실패하면 아무것도 바뀌지 않는다.
--
-- 동시성(READ COMMITTED): publish_scenario 의 UPDATE 가 진행 중인 save_scenario 와 같은 행을 만나면 그 커밋을 기다린 뒤
-- 새 행 버전으로 updated_at 조건을 다시 보아 0행 → false. 두 set_group_links 는 groups 행 UPDATE 잠금으로 줄을 선다.
-- 검증 실패는 SQLSTATE 22023(invalid_parameter_value)으로 raise 한다: 서버가 400 validation_failed 로 옮긴다.

do $$ begin
  if exists (select 1 from schema_migrations where version = '0004') then
    raise exception 'migration 0004 already applied';
  end if;
end $$;

-- p_input = ScenarioInput JSON {lang, student_prefix, mentor_prefix, grade, internal, classification, translations: {ko, en}}.
--   p_slug 있음 → 새 시나리오 p_id 를 draft 로 만든다. p_slug null → 기존 p_id 를 덮어쓰고 draft + compiled_prompt null(없으면 false).
create function save_scenario(p_id uuid, p_slug text, p_input jsonb)
  returns boolean language plpgsql volatile security invoker set search_path = public as $$
declare
  l text;
  t jsonb;
begin
  if p_slug is not null then
    insert into scenarios (id, slug, status, lang, student_prefix, mentor_prefix, grade, internal, classification, compiled_prompt)
    values (p_id, p_slug, 'draft', p_input->>'lang', p_input->>'student_prefix', p_input->>'mentor_prefix', p_input->>'grade',
            p_input->'internal', p_input->'classification', null);
  else
    update scenarios
       set status = 'draft', compiled_prompt = null, lang = p_input->>'lang', student_prefix = p_input->>'student_prefix',
           mentor_prefix = p_input->>'mentor_prefix', grade = p_input->>'grade', internal = p_input->'internal', classification = p_input->'classification'
     where id = p_id;
    if not found then
      return false;
    end if;
  end if;
  foreach l in array array['ko', 'en'] loop
    t := p_input->'translations'->l;
    insert into scenario_translations (scenario_id, lang, name, description, problem, chars, greet, aha, t1, t2, t3, confused, elicit, misconceptions)
    values (p_id, l, t->>'name', t->>'description', t->>'problem', t->>'chars', t->>'greet', t->>'aha', t->>'t1', t->>'t2', t->>'t3',
            t->'confused', t->'elicit', t->'misconceptions')
    on conflict (scenario_id, lang) do update
       set name = excluded.name, description = excluded.description, problem = excluded.problem, chars = excluded.chars,
           greet = excluded.greet, aha = excluded.aha, t1 = excluded.t1, t2 = excluded.t2, t3 = excluded.t3,
           confused = excluded.confused, elicit = excluded.elicit, misconceptions = excluded.misconceptions;
  end loop;
  return true;
end $$;

-- 읽은 updated_at 그대로일 때만 published + 컴파일본. 그새 저장·삭제됐으면 false(아무것도 바꾸지 않음).
create function publish_scenario(p_id uuid, p_expected_updated_at timestamptz, p_compiled jsonb)
  returns boolean language plpgsql volatile security invoker set search_path = public as $$
begin
  update scenarios set status = 'published', compiled_prompt = p_compiled
   where id = p_id and updated_at = p_expected_updated_at;
  return found;
end $$;

-- 구성원(예비교사만)·시나리오 연결을 전체 치환. 중복 id 는 하나로.
--   p_create → 그룹 p_group_id 를 이름 p_name 으로 만든다. 아니면 기존 그룹(없으면 false), p_name 이 있으면 이름도 바꾼다.
create function set_group_links(p_group_id uuid, p_member_ids uuid[], p_scenario_ids uuid[], p_name text default null, p_create boolean default false)
  returns boolean language plpgsql volatile security invoker set search_path = public as $$
begin
  if exists (select 1 from unnest(p_member_ids) m where not exists (select 1 from users u where u.id = m and u.role = 'teacher')) then
    raise exception 'unknown member id or not a teacher' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_scenario_ids) s where not exists (select 1 from scenarios x where x.id = s)) then
    raise exception 'unknown scenario id' using errcode = '22023';
  end if;
  if p_create then
    insert into groups (id, name) values (p_group_id, p_name);
  else
    update groups set name = coalesce(p_name, name) where id = p_group_id;
    if not found then
      return false;
    end if;
  end if;
  delete from group_members   where group_id = p_group_id and user_id     <> all (p_member_ids);
  delete from group_scenarios where group_id = p_group_id and scenario_id <> all (p_scenario_ids);
  insert into group_members (group_id, user_id) select distinct p_group_id, m from unnest(p_member_ids) m on conflict do nothing;
  insert into group_scenarios (group_id, scenario_id) select distinct p_group_id, s from unnest(p_scenario_ids) s on conflict do nothing;
  return true;
end $$;

revoke all on function save_scenario(uuid, text, jsonb)                          from public, anon, authenticated;
revoke all on function publish_scenario(uuid, timestamptz, jsonb)                from public, anon, authenticated;
revoke all on function set_group_links(uuid, uuid[], uuid[], text, boolean)      from public, anon, authenticated;
grant execute on function save_scenario(uuid, text, jsonb)                       to service_role;
grant execute on function publish_scenario(uuid, timestamptz, jsonb)             to service_role;
grant execute on function set_group_links(uuid, uuid[], uuid[], text, boolean)   to service_role;

insert into schema_migrations (version, name) values ('0004', 'admin_atomic');
