-- 0003_start_session.sql — 세션 시작과 턴 기록을 DB 안에서 원자적으로, 턴은 claim 토큰으로 울타리 친다 (#42 rev 3, F-22·F-24·F-25, D-14, #35 O-2와 같은 원칙)
--
-- 적용 전제는 0001·0002와 같다: `psql --single-transaction -v ON_ERROR_STOP=1 -f`, 맨 앞 가드, 맨 끝 schema_migrations 기록.
--
-- start_session: Data API(PostgREST)는 요청 사이에 트랜잭션을 묶을 수 없다. 세션 행과 인사 발화(seq 1)를 따로 넣으면 그 사이에
-- 복구(GET /api/sessions/current)·턴이 인사 없는 세션을 보고 seq 1 을 먼저 쓸 수 있다. 그래서 둘을 함수 하나(= rpc 한 번)로 넣는다.
-- 같은 사용자의 두 시작은 sessions_one_active(부분 unique, 0001)에서 하나가 23505 로 실패하고 함수 전체가 롤백된다.
--
-- 턴 울타리: 0001 의 claim_turn/record_turn 은 "누가 잡았는지"를 몰라서, 시간 초과로 잡기를 빼앗긴 느린 턴이 뒤늦게 기록하며
-- 그사이 다른 턴이 저장한 종료(ended_at·report)를 되돌릴 수 있었다. 이제 서버가 턴마다 토큰(uuid)을 만들어 잡고,
-- record_turn·release_turn 은 그 토큰이 아직 sessions.turn_claim 일 때만 쓴다. 검사와 쓰기는 같은 UPDATE ... WHERE 하나라서
-- 행 잠금 아래에서 일어난다(READ COMMITTED: 잠금을 기다린 UPDATE 는 새 행 버전으로 WHERE 를 다시 본다).

do $$ begin
  if exists (select 1 from schema_migrations where version = '0003') then
    raise exception 'migration 0003 already applied';
  end if;
end $$;

-- 지금 턴을 잡은 요청의 토큰. turn_started_at 과 함께 세팅·해제된다(null = 진행 중 턴 없음).
alter table sessions add column turn_claim uuid;

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

drop function claim_turn(uuid, integer);
drop function record_turn(uuid, jsonb, jsonb, jsonb, boolean, timestamptz, jsonb);

-- 끝나지 않은 세션이고 진행 중 턴이 없거나 그 턴이 p_timeout_ms 를 넘긴 고아(티켓 19 §3)일 때만 p_token 으로 잡고 true.
create function claim_turn(p_session_id uuid, p_token uuid, p_timeout_ms integer)
  returns boolean language plpgsql volatile security invoker set search_path = public as $$
begin
  update sessions set turn_claim = p_token, turn_started_at = now()
   where id = p_session_id and ended_at is null
     and (turn_started_at is null or turn_started_at < now() - make_interval(secs => p_timeout_ms / 1000.0));
  return found;
end $$;

-- 이번 턴 발화 n행(seq 는 서버가 매김) insert + sessions 상태 갱신 + 잡기 해제를 한 트랜잭션으로. 종료 턴은 p_turns = '[]' 에 ended_at·report.
-- p_token 이 아직 turn_claim 이고 세션이 끝나지 않았을 때만 쓴다. 아니면(빼앗김·이미 종료) 아무것도 쓰지 않고 false.
create function record_turn(p_session_id uuid, p_token uuid, p_turns jsonb, p_progress jsonb, p_counts jsonb, p_goal_reached boolean,
                            p_ended_at timestamptz, p_report jsonb)
  returns boolean language plpgsql volatile security invoker set search_path = public as $$
begin
  update sessions
     set progress = p_progress, counts = p_counts, goal_reached = p_goal_reached, ended_at = p_ended_at, report = p_report,
         turn_started_at = null, turn_claim = null
   where id = p_session_id and turn_claim = p_token and ended_at is null;
  if not found then
    return false;
  end if;
  insert into turns (session_id, seq, speaker, text, leverage, object, trigger)
    select p_session_id, t.seq, t.speaker, t.text, t.leverage, t.object, t.trigger
      from jsonb_to_recordset(p_turns) as t(seq integer, speaker text, text text, leverage text, object text, trigger smallint);
  return true;
end $$;

-- 잡기 해제: p_token 이 아직 turn_claim 일 때만 풀고 true. 이미 기록됐거나 빼앗겼으면 아무것도 하지 않고 false.
-- 결과를 모르는 record_turn 의 울타리이기도 하다: 이 UPDATE 는 같은 행 잠금을 잡으므로 진행 중인 record_turn 을 기다린다.
-- true = 그 record_turn 은 앞으로도 커밋할 수 없다(토큰이 풀려 WHERE 가 거짓). false = 토큰이 이미 없다(기록됐거나 빼앗김).
create function release_turn(p_session_id uuid, p_token uuid)
  returns boolean language plpgsql volatile security invoker set search_path = public as $$
begin
  update sessions set turn_claim = null, turn_started_at = null where id = p_session_id and turn_claim = p_token;
  return found;
end $$;

revoke all on function start_session(uuid, uuid, text, jsonb, jsonb, text)                          from public, anon, authenticated;
revoke all on function claim_turn(uuid, uuid, integer)                                             from public, anon, authenticated;
revoke all on function record_turn(uuid, uuid, jsonb, jsonb, jsonb, boolean, timestamptz, jsonb)   from public, anon, authenticated;
revoke all on function release_turn(uuid, uuid)                                                    from public, anon, authenticated;
grant execute on function start_session(uuid, uuid, text, jsonb, jsonb, text)                        to service_role;
grant execute on function claim_turn(uuid, uuid, integer)                                           to service_role;
grant execute on function record_turn(uuid, uuid, jsonb, jsonb, jsonb, boolean, timestamptz, jsonb) to service_role;
grant execute on function release_turn(uuid, uuid)                                                  to service_role;

insert into schema_migrations (version, name) values ('0003', 'start_session');
