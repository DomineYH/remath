-- 0002_auth_atomic.sql — 로그인 발급과 비밀번호 교체를 DB 안에서 원자적으로 (#40 rev 3, C-12, #35 O-2와 같은 원칙)
--
-- 적용 전제는 0001과 같다: `psql --single-transaction -v ON_ERROR_STOP=1 -f`, 맨 앞 가드, 맨 끝 schema_migrations 기록.
-- Data API(PostgREST)는 요청 사이에 트랜잭션을 묶을 수 없으므로, "검증한 해시로만 로그인 발급"과
-- "해시 교체 + 다른 로그인 삭제"를 각각 함수 하나(= rpc 한 번 = 트랜잭션 하나)로 만든다.
--
-- 동시성(READ COMMITTED, plpgsql 문마다 새 스냅숏):
--   - issue_session 은 users 행을 password_hash = 검증한 해시 조건으로 FOR SHARE 잠근다.
--     change_password 의 UPDATE 가 먼저 커밋됐으면 조건이 거짓이라 false. UPDATE 가 진행 중이면 잠금을 기다린 뒤
--     새 행 버전으로 조건을 다시 보아 false. issue_session 이 먼저 잠갔으면 UPDATE 가 그 커밋을 기다리고,
--     뒤따르는 DELETE 는 새 스냅숏이라 방금 들어간 로그인도 지운다.
--   - 두 change_password 가 같은 기대 해시로 겹치면 뒤의 UPDATE 는 잠금 뒤 조건을 다시 보아 0행 → false, 아무것도 바꾸지 않는다.

do $$ begin
  if exists (select 1 from schema_migrations where version = '0002') then
    raise exception 'migration 0002 already applied';
  end if;
end $$;

-- 검증한 해시가 아직 현재 해시이고 역할이 실과 같을 때만 auth_sessions 행을 넣고 true. 아니면 false(아무것도 넣지 않음).
create function issue_session(p_user_id uuid, p_verified_hash text, p_realm text, p_token_hash text, p_expires_at timestamptz)
  returns boolean language plpgsql volatile security invoker set search_path = public as $$
begin
  perform 1 from users
   where id = p_user_id and password_hash = p_verified_hash and role = p_realm
     for share;
  if not found then
    return false;
  end if;
  insert into auth_sessions (user_id, realm, token_hash, expires_at) values (p_user_id, p_realm, p_token_hash, p_expires_at);
  return true;
end $$;

-- 해시 교체 + pw_updated_at = now() + 그 사용자의 로그인 삭제를 한 트랜잭션으로. 교체된 행이 없으면 false(아무것도 바꾸지 않음).
--   p_expected_hash = null → 현재 해시와 무관한 무조건 재설정(관리자 재설정 #43, CLI 초기화 #45).
--   p_keep_token_hash = null → 그 사용자의 로그인을 모두 끝낸다. 값이 있으면 그 토큰 하나만 남긴다(본인 비밀번호 변경).
create function change_password(p_user_id uuid, p_expected_hash text, p_new_hash text, p_keep_token_hash text)
  returns boolean language plpgsql volatile security invoker set search_path = public as $$
begin
  update users set password_hash = p_new_hash, pw_updated_at = now()
   where id = p_user_id and (p_expected_hash is null or password_hash = p_expected_hash);
  if not found then
    return false;
  end if;
  delete from auth_sessions where user_id = p_user_id and (p_keep_token_hash is null or token_hash <> p_keep_token_hash);
  return true;
end $$;

revoke all on function issue_session(uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function change_password(uuid, text, text, text)            from public, anon, authenticated;
grant execute on function issue_session(uuid, text, text, text, timestamptz) to service_role;
grant execute on function change_password(uuid, text, text, text)            to service_role;

insert into schema_migrations (version, name) values ('0002', 'auth_atomic');
