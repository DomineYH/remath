// 쿠키·auth_sessions·실 해석·로그인 실패 카운터 (C-7~C-10, O-1, O-12).
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

const MAX_FAILS = 5, WINDOW_MS = 60_000;

/** 메모리 Map, 키 = (실, 소문자 닉네임). 5회째 실패부터 60초 잠금, 실패 사이가 60초를 넘으면 처음부터, 성공하면 리셋. 단일 프로세스(C3) 전제. */
export function createLimiter() {
  const m = new Map<string, { fails: number; last: number }>();
  const key = (realm: ClientRealm, nick: string) => `${realm}:${nick.toLowerCase()}`;
  const live = (k: string, now: number) => {
    const e = m.get(k);
    if (e && now - e.last >= WINDOW_MS) { m.delete(k); return undefined; }
    return e;
  };
  return {
    /** 잠겨 있으면 남은 초(retry_after), 아니면 null. */
    check(realm: ClientRealm, nick: string, now: number): number | null {
      const e = live(key(realm, nick), now);
      return e && e.fails >= MAX_FAILS ? Math.ceil((e.last + WINDOW_MS - now) / 1000) : null;
    },
    fail(realm: ClientRealm, nick: string, now: number) {
      // ponytail: 입력 닉네임마다 키가 생기므로 커지면 만료분을 한 번에 쓸어낸다. 다중 프로세스가 되면 공유 저장소로.
      if (m.size > 10_000) for (const k of m.keys()) live(k, now);
      const k = key(realm, nick), e = live(k, now);
      m.set(k, { fails: (e?.fails ?? 0) + 1, last: now });
    },
    reset(realm: ClientRealm, nick: string) { m.delete(key(realm, nick)); },
  };
}

// ---- 쿠키·auth_sessions (C-7, C-10) ----------------------------------------------------------
export const COOKIE: Record<ClientRealm, string> = { teacher: 'remath_teacher', admin: 'remath_admin' };
export const TTL_MS: Record<ClientRealm, number> = { teacher: 7 * 24 * 3600_000, admin: 12 * 3600_000 };
export const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const cookieOptions = (realm: ClientRealm, secure: boolean) =>
  ({ httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: TTL_MS[realm] / 1000 }) as const;

export interface AuthUser { id: string; nickname: string; role: ClientRealm; pw_updated_at: string; password_hash: string }
export interface Auth { realm: ClientRealm; tokenHash: string; user: AuthUser }

/**
 * 토큰 → 로그인. 없음·만료 = unauthorized, 다른 실의 토큰·역할 = forbidden. last_seen_at 은 갱신하지 않는다.
 * 비밀번호가 바뀐 뒤에는 그 전에 만든 로그인이 모두 끝난다: created_at <= users.pw_updated_at 이면 unauthorized(C-12).
 * auth_sessions 삭제가 실패해도 이 규칙이 막는다. 두 시각은 모두 서버 시계(Deps.now)로 쓴다 — pw_updated_at 을 바꾸는 곳은 모두 그 시계로.
 */
export async function authenticate(db: Db, realm: ClientRealm, token: string, now: Date): Promise<Auth | 'unauthorized' | 'forbidden'> {
  const tokenHash = sha256(token);
  const row = must(await db.from('auth_sessions')
    .select('realm, expires_at, created_at, user:users!inner(id, nickname, role, pw_updated_at, password_hash)')
    .eq('token_hash', tokenHash).maybeSingle()) as { realm: ClientRealm; expires_at: string; created_at: string; user: AuthUser } | null;
  if (!row || Date.parse(row.expires_at) <= now.getTime() || Date.parse(row.created_at) <= Date.parse(row.user.pw_updated_at)) return 'unauthorized';
  if (row.realm !== realm || row.user.role !== realm) return 'forbidden';
  return { realm, tokenHash, user: row.user };
}
