// 쿠키·실 해석·로그인 실패 카운터 (C-7~C-10, O-1, O-12). 순수 함수만 — DB는 routes/auth.ts.
import type { Realm } from '@remath/shared';

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
