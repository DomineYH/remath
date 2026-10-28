-- 0003_start_session.sql — 연습 세션 시작을 DB 안에서 원자적으로 (#42 rev 2, F-25, D-14, #35 O-2와 같은 원칙)
--
-- 적용 전제는 0001·0002와 같다: `psql --single-transaction -v ON_ERROR_STOP=1 -f`, 맨 앞 가드, 맨 끝 schema_migrations 기록.
-- Data API(PostgREST)는 요청 사이에 트랜잭션을 묶을 수 없다. 세션 행과 인사 발화(seq 1)를 따로 넣으면 그 사이에
-- 복구(GET /api/sessions/current)·턴이 인사 없는 세션을 보고 seq 1 을 먼저 쓸 수 있다. 그래서 둘을 함수 하나(= rpc 한 번)로 넣는다.
--
-- 동시성: 같은 사용자의 두 시작은 sessions_one_active(부분 unique, 0001)에서 하나가 23505 로 실패하고, 함수 전체가 롤백되어
-- 그쪽 인사 발화도 남지 않는다. 서버는 23505 를 409 session_active 로 바꾼다.

do $$ begin
  if exists (select 1 from schema_migrations where version = '0003') then
    raise exception 'migration 0003 already applied';
  end if;
end $$;

-- 세션 1행 + 인사 발화(seq 1, student) 1행을 넣고 세션 id 를 돌려준다. 접근 검사(teacher_scenarios·관리자)는 부른 쪽이 끝냈다.
create function start_session(p_user_id uuid, p_scenario_id uuid, p_lang text, p_progress jsonb, p_counts jsonb, p_greet text)
  returns uuid language plpgsql volatile security invoker set search_path = public as $$
declare
  v_id uuid;
begin
  insert into sessions (user_id, scenario_id, lang, progress, counts)
    values (p_user_id, p_scenario_id, p_lang, p_progress, p_counts)
    returning id into v_id;
  insert into turns (session_id, seq, speaker, text) values (v_id, 1, 'student', p_greet);
  return v_id;
end $$;

revoke all on function start_session(uuid, uuid, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function start_session(uuid, uuid, text, jsonb, jsonb, text) to service_role;

insert into schema_migrations (version, name) values ('0003', 'start_session');
