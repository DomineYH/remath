// 인증 9종 (C-7~C-12): 계정 만들기·로그인·로그아웃·me·비밀번호 변경 × 예비교사/관리자.
import type * as S from '@remath/shared';
import argon2 from 'argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Handlers, Deps } from '../app.ts';
import { audit } from '../audit.ts';
import { COOKIE, cookieOptions, newToken, sha256, TTL_MS, type AuthUser, type ClientRealm } from '../auth.ts';
import { must } from '../db.ts';
import { ApiFail } from '../errors.ts';

type Credentials = z.infer<typeof S.Credentials>;
const me = (u: Pick<AuthUser, 'id' | 'nickname' | 'role' | 'pw_updated_at'>): z.infer<typeof S.Me> =>
  ({ id: u.id, nickname: u.nickname, role: u.role, pw_updated_at: u.pw_updated_at });
const ME_COLS = 'id, nickname, role, pw_updated_at';

export function authHandlers({ db, config, limiter, now }: Deps): Handlers {
  const secure = config.env.COOKIE_SECURE;
  // 없는 닉네임도 같은 시간 동안 해시를 검사해 응답 시간으로 존재가 드러나지 않게 한다.
  const dummyHash = argon2.hash(newToken());

  /** 검증한 해시가 아직 현재 해시일 때만 로그인을 만든다(0002 issue_session, 한 트랜잭션). 아니면 null. */
  const issue = async (realm: ClientRealm, userId: string, verifiedHash: string) => {
    const token = newToken();
    const ok = must(await db.rpc('issue_session', {
      p_user_id: userId, p_verified_hash: verifiedHash, p_realm: realm, p_token_hash: sha256(token),
      p_expires_at: new Date(now().getTime() + TTL_MS[realm]).toISOString(),
    }));
    return ok === true ? token : null;
  };
  const give = (reply: FastifyReply, realm: ClientRealm, token: string) => reply.setCookie(COOKIE[realm], token, cookieOptions(realm, secure));

  const login = (realm: ClientRealm) => async (req: FastifyRequest, reply: FastifyReply) => {
    const { nickname, password } = req.body as Credentials;
    const failed = (reason: string) => audit(db, req.log, { actor_id: null, action: 'auth.login_failed', target: nickname, meta: { realm, reason } });
    const tooMany = (wait: number) => new ApiFail('too_many_attempts', 'too many failed attempts', { retry_after: wait });
    const wait = limiter.check(realm, nickname, now().getTime());
    if (wait !== null) {
      await failed('too_many_attempts');
      throw tooMany(wait);
    }
    // 닉네임 문자 집합(Nickname) 중 LIKE 와일드카드는 _ 뿐이다.
    const u = must(await db.from('users').select(`${ME_COLS}, password_hash`)
      .eq('role', realm).ilike('nickname', nickname.replaceAll('_', '\\_')).maybeSingle()) as AuthUser | null;
    const ok = await argon2.verify(u?.password_hash ?? await dummyHash, password);
    if (!u || !ok) {   // 없는 닉네임과 틀린 비밀번호는 같은 401, 5번째 실패부터는 429
      limiter.fail(realm, nickname, now().getTime());
      await failed('invalid_credentials');
      const locked = limiter.check(realm, nickname, now().getTime());
      throw locked !== null ? tooMany(locked) : new ApiFail('invalid_credentials', 'invalid nickname or password');
    }
    limiter.reset(realm, nickname);
    const token = await issue(realm, u.id, u.password_hash);
    if (!token) {   // 검사와 발급 사이에 비밀번호가 바뀌었다: 옛 비밀번호로는 로그인을 만들지 않는다(C-12)
      await failed('password_changed');
      throw new ApiFail('invalid_credentials', 'invalid nickname or password');
    }
    give(reply, realm, token);
    return me(u);
  };

  const logout = (realm: ClientRealm) => async (req: FastifyRequest, reply: FastifyReply) => {
    must(await db.from('auth_sessions').delete().eq('token_hash', req.auth!.tokenHash));
    reply.clearCookie(COOKIE[realm], cookieOptions(realm, secure)).code(204).send();
  };

  /**
   * 현재 비밀번호 확인 → 해시 교체 + 이 토큰 말고 그 사용자의 로그인 모두 삭제(0002 change_password, 한 트랜잭션) → 감사 1행.
   * 확인한 해시가 그새 바뀌었으면(겹친 변경) 아무것도 바꾸지 않고 401.
   */
  const changePassword = (realm: ClientRealm) => async (req: FastifyRequest, reply: FastifyReply) => {
    const { current, next } = req.body as z.infer<typeof S.PasswordChange>;
    const { user, tokenHash } = req.auth!;
    if (!(await argon2.verify(user.password_hash, current))) throw new ApiFail('invalid_credentials', 'current password is incorrect');
    const ok = must(await db.rpc('change_password', {
      p_user_id: user.id, p_expected_hash: user.password_hash, p_new_hash: await argon2.hash(next), p_keep_token_hash: tokenHash,
    }));
    if (ok !== true) throw new ApiFail('invalid_credentials', 'password was changed meanwhile');
    await audit(db, req.log, { actor_id: user.id, action: 'auth.password_change', target: user.id, meta: { realm } });
    reply.code(204).send();
  };

  const whoami = async (req: FastifyRequest) => me(req.auth!.user);

  return {
    /** 계정 만들기 = 바로 로그인(201). 닉네임은 users_nickname_key(lower) 로 대소문자 무시 유일. */
    'POST /api/auth/signup': async (req, reply) => {
      const { nickname, password } = req.body as Credentials;
      const hash = await argon2.hash(password);
      const r = await db.from('users').insert({ nickname, password_hash: hash, role: 'teacher' }).select(ME_COLS).single();
      if (r.error?.code === '23505') throw new ApiFail('nickname_taken', 'nickname is taken');
      const u = must(r) as AuthUser;
      const token = await issue('teacher', u.id, hash);
      if (!token) throw new Error('issue_session refused a just-created user');
      give(reply, 'teacher', token);
      reply.code(201);
      return me(u);
    },
    'POST /api/auth/login': login('teacher'),
    'POST /api/auth/logout': logout('teacher'),
    'GET /api/auth/me': whoami,
    'PUT /api/auth/password': changePassword('teacher'),
    'POST /api/admin/auth/login': login('admin'),
    'POST /api/admin/auth/logout': logout('admin'),
    'GET /api/admin/auth/me': whoami,
    'PUT /api/admin/auth/password': changePassword('admin'),
  };
}
