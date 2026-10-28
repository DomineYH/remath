// 로그인·계정 (쿠키 = 실별 토큰). 비밀번호 변경 = 이 토큰 말고 그 사용자의 다른 로그인 종료.
import type * as S from '@remath/shared';
import type { z } from 'zod';
import type { Api, ClientRealm } from '../types.ts';
import { audit } from './audit.ts';
import { fail, type Ctx } from './context.ts';
import { hashPassword, verifyPassword } from './crypto.ts';
import type { UserRow } from './store.ts';

export function auth(c: Ctx) {
  const { db, jar, now, uuid, save, who } = c;
  const me = (u: UserRow): z.infer<typeof S.Me> => ({ id: u.id, nickname: u.nickname, role: u.role, pw_updated_at: u.pw_updated_at });
  const issue = (realm: ClientRealm, u: UserRow) => {
    const token = uuid();
    db.auth_sessions.push({ id: uuid(), user_id: u.id, realm, token_hash: token, created_at: now() });
    jar[realm] = token;
  };
  const passwordOk = async (u: UserRow, pw: string) => u.password_hash
    ? verifyPassword(pw, u.password_hash)
    : !!c.adminPassword && u.role === 'admin' && verifyPassword(pw, await hashPassword(c.adminPassword));
  const loginAs = async (realm: ClientRealm, b: z.infer<typeof S.Credentials>) => {
    const u = db.users.find(u => u.role === realm && u.nickname.toLowerCase() === b.nickname.toLowerCase());
    if (!u || !(await passwordOk(u, b.password))) {   // 없는 닉네임과 틀린 비밀번호는 같은 401
      audit(db, now(), { actor_id: null, action: 'auth.login_failed', target: b.nickname, meta: { realm, reason: 'invalid_credentials' } });
      save(); return fail('invalid_credentials', 'invalid nickname or password');   // ponytail: 5회 실패 429(too_many_attempts)는 흉내 내지 않는다
    }
    issue(realm, u); save(); return me(u);
  };
  const logoutOf = (realm: ClientRealm) => {
    db.auth_sessions = db.auth_sessions.filter(a => !(a.realm === realm && a.token_hash === jar[realm]));
    jar[realm] = null; save();
  };
  const setPassword = async (u: UserRow, pw: string, t: string) => { u.password_hash = await hashPassword(pw); u.pw_updated_at = t; u.updated_at = t; };
  /** 계정 만들기·사용자 추가: 닉네임은 대소문자 무시 유일(409). */
  const addTeacher = async (b: z.infer<typeof S.Credentials>) => {
    if (db.users.some(u => u.nickname.toLowerCase() === b.nickname.toLowerCase())) fail('nickname_taken');
    const t = now(), u: UserRow = { id: uuid(), nickname: b.nickname, password_hash: null, role: 'teacher', pw_updated_at: t, created_at: t, updated_at: t };
    await setPassword(u, b.password, t); db.users.push(u); return u;
  };
  /** 현재 비밀번호 확인 → 해시 교체 → 이 토큰 말고 그 사용자의 로그인 모두 종료 → 감사 1행. */
  const changePw = async (realm: ClientRealm, b: z.infer<typeof S.PasswordChange>) => {
    const u = who(realm);
    if (!(await passwordOk(u, b.current))) fail('invalid_credentials', 'current password is incorrect');
    const t = now();
    await setPassword(u, b.next, t);
    db.auth_sessions = db.auth_sessions.filter(a => a.user_id !== u.id || a.token_hash === jar[realm]);
    audit(db, t, { actor_id: u.id, action: 'auth.password_change', target: u.id, meta: { realm } });
    save();
  };

  const api = {
    signup: async b => { const u = await addTeacher(b); issue('teacher', u); save(); return me(u); },   // 계정 만들기 = 바로 로그인
    login: b => loginAs('teacher', b), logout: async () => logoutOf('teacher'), me: async () => me(who('teacher')), changePassword: b => changePw('teacher', b),
    adminLogin: b => loginAs('admin', b), adminLogout: async () => logoutOf('admin'), adminMe: async () => me(who('admin')), adminChangePassword: b => changePw('admin', b),
  } satisfies Partial<Api>;
  return { api, addTeacher, setPassword };
}
