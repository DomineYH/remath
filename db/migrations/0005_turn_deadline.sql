-- 0005_turn_deadline.sql — record_turn 이 턴 시간 제한도 지킨다 (stage 2 리뷰, GLOSSARY "턴 시간 제한")
--
-- 적용 전제는 0001~0004와 같다: `psql --single-transaction -v ON_ERROR_STOP=1 -f`, 맨 앞 가드, 맨 끝 schema_migrations 기록.
--
-- 0003 record_turn 은 토큰만 보았다. 서버는 기록 직전에 기한을 보지만 record_turn 이 느리면(DB 지연·잠금 대기) 기한을 넘긴 턴이
-- 그대로 커밋되고 done 이 나갔다. 이제 같은 UPDATE ... WHERE 안에서 잡은 시각(turn_started_at, claim_turn 이 DB 시각으로 세팅)부터
-- p_timeout_ms 가 지나지 않았는지도 본다 — 앱과 DB 시계를 비교하지 않는다. 기준은 clock_timestamp()(쓰는 순간):
-- now() 는 트랜잭션 시작 시각이라 잠금을 기다린 시간을 빼먹는다.
-- 늦으면 아무것도 쓰지 않고 false 이며 잡기(turn_claim)는 그대로 둔다: 서버가 release_turn(token) 으로 풀고(true = 기한 초과였다)
-- 시간 초과 경로와 같은 오류를 낸다. release_turn 의 울타리(0003)는 그대로다.

do $$ begin
  if exists (select 1 from schema_migrations where version = '0005') then
    raise exception 'migration 0005 already applied';
  end if;
end $$;

drop function record_turn(uuid, uuid, jsonb, jsonb, jsonb, boolean, timestamptz, jsonb);

-- 0003 과 같되 p_timeout_ms: p_token 이 아직 turn_claim 이고, 세션이 끝나지 않았고, 잡은 지 p_timeout_ms 이내일 때만 쓰고 true.
create function record_turn(p_session_id uuid, p_token uuid, p_timeout_ms integer, p_turns jsonb, p_progress jsonb, p_counts jsonb,
                            p_goal_reached boolean, p_ended_at timestamptz, p_report jsonb)
  returns boolean language plpgsql volatile security invoker set search_path = public as $$
begin
  update sessions
     set progress = p_progress, counts = p_counts, goal_reached = p_goal_reached, ended_at = p_ended_at, report = p_report,
         turn_started_at = null, turn_claim = null
   where id = p_session_id and turn_claim = p_token and ended_at is null
     and turn_started_at >= clock_timestamp() - make_interval(secs => p_timeout_ms / 1000.0);
  if not found then
    return false;
  end if;
  insert into turns (session_id, seq, speaker, text, leverage, object, trigger)
    select p_session_id, t.seq, t.speaker, t.text, t.leverage, t.object, t.trigger
      from jsonb_to_recordset(p_turns) as t(seq integer, speaker text, text text, leverage text, object text, trigger smallint);
  return true;
end $$;

revoke all on function record_turn(uuid, uuid, integer, jsonb, jsonb, jsonb, boolean, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function record_turn(uuid, uuid, integer, jsonb, jsonb, jsonb, boolean, timestamptz, jsonb) to service_role;

insert into schema_migrations (version, name) values ('0005', 'turn_deadline');
