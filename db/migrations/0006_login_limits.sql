-- 0006_login_limits.sql — 로그인 실패 카운터를 DB로 (V12, C-8, O-12)
--
-- 적용 전제는 0001~0005와 같다: `psql --single-transaction -v ON_ERROR_STOP=1 -f`, 맨 앞 가드, 맨 끝 schema_migrations 기록.
--
-- 서버 인스턴스가 여럿이어도 같은 규칙(C3)이 지켜지도록 프로세스 메모리 Map 을 표 하나로 옮긴다. 키 = (실, 소문자 닉네임).
-- 규칙은 그대로다: 5회째 실패부터 마지막 실패 뒤 60초 잠금, 실패 사이가 60초 이상이면 처음부터, 성공하면 리셋.
-- 잠금 중에는 남은 초(올림)를 retry_after 로 돌려준다.
--
-- 시계는 DB 하나다(clock_timestamp(), 쓰는 순간). 인스턴스마다 다른 앱 시계를 섞지 않는다(0005와 같은 원칙).
-- 검사·기록은 각각 한 문장이다(rpc 한 번 = 트랜잭션 하나):
--   - login_check: SELECT 하나.
--   - login_fail: INSERT ... ON CONFLICT DO UPDATE 하나. 같은 키의 동시 실패는 행 잠금에서 줄을 서고, 뒤의 것은 앞의 커밋된
--     행 버전으로 식을 다시 계산하므로 하나도 빠지지 않고 센다. 그 뒤 같은 트랜잭션에서 만료된 다른 키를 쓸어낸다(표가 끝없이
--     커지지 않게). 쓸기는 SKIP LOCKED 라 다른 rpc 를 기다리지 않는다: upsert 가 먼저, 쓸기가 나중이므로 잠금 순환(교착)이 없다.
--     만료 행은 검사·기록 어느 쪽에도 영향이 없으므로(검사는 무시하고 기록은 1부터 다시 센다) 지우는 시점은 결과를 바꾸지 않는다.
--   - login_reset: DELETE 하나.

do $$ begin
  if exists (select 1 from schema_migrations where version = '0006') then
    raise exception 'migration 0006 already applied';
  end if;
end $$;

create table login_limits (
  realm        text        not null check (realm in ('teacher', 'admin')),
  nick         text        not null check (nick = lower(nick)),
  fails        integer     not null check (fails > 0),
  last_fail_at timestamptz not null,
  primary key (realm, nick)
);
create index login_limits_last_fail_idx on login_limits (last_fail_at);   -- 만료 쓸기

alter table login_limits enable row level security;
revoke all on table login_limits from public, anon, authenticated;

-- 잠겨 있으면 남은 초(올림, 1 이상), 아니면 null.
create function login_check(p_realm text, p_nick text)
  returns integer language sql volatile security invoker set search_path = public as $$
  select ceil(extract(epoch from (l.last_fail_at + interval '60 seconds' - n.t)))::integer
    from login_limits l, (select clock_timestamp() as t) n
   where l.realm = p_realm and l.nick = lower(p_nick) and l.fails >= 5 and l.last_fail_at > n.t - interval '60 seconds'
$$;

-- 실패 하나를 기록한다. 이 실패로 잠겼으면(5회째 이상) retry_after = 60, 아니면 null.
create function login_fail(p_realm text, p_nick text)
  returns integer language plpgsql volatile security invoker set search_path = public as $$
declare
  v_fails integer;
begin
  insert into login_limits as l (realm, nick, fails, last_fail_at)
       values (p_realm, lower(p_nick), 1, clock_timestamp())
  on conflict (realm, nick) do update
     set fails = case when l.last_fail_at > excluded.last_fail_at - interval '60 seconds' then l.fails + 1 else 1 end,
         last_fail_at = excluded.last_fail_at
  returning fails into v_fails;

  -- 만료 쓸기(최대 500행): 마지막 실패가 60초 이상 지난 키. 방금 기록한 키는 새 시각이라 걸리지 않는다.
  delete from login_limits
   where (realm, nick) in (select realm, nick from login_limits
                            where last_fail_at <= clock_timestamp() - interval '60 seconds'
                            limit 500 for update skip locked);

  return case when v_fails >= 5 then 60 end;
end $$;

-- 성공: 그 키의 카운터를 지운다.
create function login_reset(p_realm text, p_nick text)
  returns void language sql volatile security invoker set search_path = public as $$
  delete from login_limits where realm = p_realm and nick = lower(p_nick)
$$;

revoke all on function login_check(text, text) from public, anon, authenticated;
revoke all on function login_fail(text, text)  from public, anon, authenticated;
revoke all on function login_reset(text, text) from public, anon, authenticated;
grant execute on function login_check(text, text) to service_role;
grant execute on function login_fail(text, text)  to service_role;
grant execute on function login_reset(text, text) to service_role;

insert into schema_migrations (version, name) values ('0006', 'login_limits');
