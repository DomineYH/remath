// 쿠키·auth_sessions·실 해석·로그인 실패 카운터 (C-7~C-10, O-1, O-12, V12).
import { createHash, randomBytes } from 'node:crypto';
import type { Realm } from '@remath/shared';
import { must, type Db } from './db.ts';

export type ClientRealm = 'teacher' | 'admin';
export type Tokens = Partial<Record<ClientRealm, string>>;
export type Resolved = { realm: ClientRealm; token: string } | { error: 'unauthorized' | 'validation_failed' };

/** 라우트 실 + `X-Remath-Realm` + 쿠키 → 어느 실의 토큰으로 행동할지. teacher/admin 라우트는 헤더를 보지 않는다. */
export function resolveRealm(route: Exclude<Realm, 'none'>, header: string | undefined, tokens: Tokens): Resolved {
  const pick = (realm: ClientRealm): Resolved => tokens[realm] ? { realm, token: tokens[realm] } : { error: 'unauthorized' };
  if (route !== 'any') return pick(route);
  if (header !== undefined) return header === 'teacher' || header === 'admin' ? pick(header) : { error: 'validation_failed' };
  if (tokens.teacher && tokens.admin) return { error: 'validation_failed' };
  return pick(tokens.admin ? 'admin' : 'teacher');
}

/**
 * 로그인 실패 카운터(C3, V12): 규칙은 DB 에 있다(0006_login_limits.sql, 키 = (실, 소문자 닉네임), DB 시계).
 * 5회째 실패부터 마지막 실패 뒤 60초 잠금, 실패 사이가 60초 이상이면 처음부터, 성공하면 리셋. 연산마다 rpc 한 번(= 한 문장)이라
 * 인스턴스가 여럿이어도 같은 카운터를 본다. 인스턴스 메모리에는 아무것도 두지 않는다. DB 오류는 던진다(잠기지 않음으로 읽지 않는다).
 */
export function createLimiter(db: Db) {
  const call = async (fn: 'login_check' | 'login_fail' | 'login_reset', realm: ClientRealm, nick: string) =>
    must(await db.rpc(fn, { p_realm: realm, p_nick: nick })) as number | null;
  return {
    /** 잠겨 있으면 남은 초(retry_after), 아니면 null. */
    check: (realm: ClientRealm, nick: string) => call('login_check', realm, nick),
    /** 실패 하나를 기록한다. 이 실패로 잠겼으면 retry_after, 아니면 null. */
    fail: (realm: ClientRealm, nick: string) => call('login_fail', realm, nick),
    reset: async (realm: ClientRealm, nick: string) => { await call('login_reset', realm, nick); },
  };
}
export type Limiter = ReturnType<typeof createLimiter>;

// ---- 쿠키·auth_sessions (C-7, C-10) ----------------------------------------------------------
export const COOKIE: Record<ClientRealm, string> = { teacher: 'remath_teacher', admin: 'remath_admin' };
export const TTL_MS: Record<ClientRealm, number> = { teacher: 7 * 24 * 3600_000, admin: 12 * 3600_000 };
export const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const cookieOptions = (realm: ClientRealm, secure: boolean) =>
  ({ httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: TTL_MS[realm] / 1000 }) as const;

export interface AuthUser { id: string; nickname: string; role: ClientRealm; pw_updated_at: string; password_hash: string }
export interface Auth { realm: ClientRealm; tokenHash: string; user: AuthUser }

/** 토큰 → 로그인. 없음·만료 = unauthorized, 다른 실의 토큰·역할 = forbidden. last_seen_at 은 갱신하지 않는다. */
export async function authenticate(db: Db, realm: ClientRealm, token: string, now: Date): Promise<Auth | 'unauthorized' | 'forbidden'> {
  const tokenHash = sha256(token);
  const row = must(await db.from('auth_sessions')
    .select('realm, expires_at, user:users!inner(id, nickname, role, pw_updated_at, password_hash)')
    .eq('token_hash', tokenHash).maybeSingle()) as { realm: ClientRealm; expires_at: string; user: AuthUser } | null;
  if (!row || Date.parse(row.expires_at) <= now.getTime()) return 'unauthorized';
  if (row.realm !== realm || row.user.role !== realm) return 'forbidden';
  return { realm, tokenHash, user: row.user };
}
