// 목 구현 — 서버 핸들러를 브라우저 안에서 흉내 낸다. #22~#27 이 라우트 표 38개를 모두 채웠다. 서버가 생기면 이 폴더만 버린다.
// 규칙(400 검증·409 중복·401 구분 없음·비밀번호 변경 = 다른 로그인 종료·세션 409/422)은 서버와 같다.
// 책임별 파일: auth(로그인·계정) · projection(응답 모양) · sessions(연습 세션·턴·CSV) · scenarios · admin(사용자·그룹·AI). 여기는 조립과 라우트 감싸기만.
import { TEMPLATES } from '@remath/prompts';
import { routes } from '@remath/shared';
import { API_ROUTES, type Api, type ClientRealm } from '../types.ts';
import { admin } from './admin.ts';
import { auth } from './auth.ts';
import { fail, type Ctx, type Jar, type MockOptions } from './context.ts';
import { projection } from './projection.ts';
import { scenarios } from './scenarios.ts';
import { sessions } from './sessions.ts';
import { memoryStorage, seedDb, Store, type Storage, type UserRow } from './store.ts';

export type { MockOptions } from './context.ts';
export { memoryStorage, seedDb, Store, STORAGE_KEY, type Storage } from './store.ts';

/** 목 번들에만 있는 고정 문자열. check:bundle 이 프로덕션 산출물에 이것이 없음을 확인한다(A-4). */
export const MOCK_MARKER = 'remath-mock-api::do-not-deploy';

let shared: Store | undefined;
export function createMockApi(o: MockOptions): Api {
  console.warn(MOCK_MARKER);
  const now = o.now ?? (() => new Date().toISOString());
  const store = o.store ?? (shared ??= new Store(o.storage ?? (globalThis as { localStorage?: Storage }).localStorage ?? memoryStorage(), () => seedDb(now())));
  const db = store.db, jar: Jar = o.cookies ?? db.login;
  const who = (realm: ClientRealm): UserRow => {
    const s = db.auth_sessions.find(a => a.realm === realm && a.token_hash === jar[realm]);
    return db.users.find(u => u.id === s?.user_id && u.role === realm) ?? fail('unauthorized');
  };
  const c: Ctx = {
    o, db, jar, now, who, uuid: () => crypto.randomUUID(), save: () => store.save(),
    turnLimit: o.turnLimit ?? 40, templates: o.templates ?? TEMPLATES,
    // ponytail: 환경변수는 관리자 *초기* 비밀번호일 뿐이다. adminChangePassword 뒤에는 저장된 해시를 쓴다(되돌리려면 remath.mock.v1 삭제).
    adminPassword: 'adminPassword' in o ? o.adminPassword : import.meta.env.VITE_MOCK_ADMIN_PASSWORD,
  };
  const p = projection(c), a = auth(c);
  const impl: Api = { ...a.api, ...sessions(c, p), ...scenarios(c, p), ...admin(c, p, a) };

  // 라우트 표의 realm 으로 로그인을 먼저 확인하고(401), 본문·쿼리를 zod 스키마로 검증한다(400 validation_failed) — 서버 미들웨어 순서.
  // 메서드마다 다시 쓰지 않도록 여기서 한 번 감싼다. SSE 메서드는 스트림 시작 전 오류를 첫 next() 에서 던진다(Api.sendTurn 계약).
  for (const [name, key] of Object.entries(API_ROUTES) as [keyof Api, string][]) {
    const [method, path] = key.split(' '), route = routes.find(r => r.method === method && r.path === path)!;
    const schema = route.body ?? route.query, i = path.includes(':') ? 1 : 0, fn = impl[name] as (...a: unknown[]) => unknown;
    const guarded = (a: unknown[]) => {
      if (route.realm !== 'none') who(route.realm === 'any' ? o.realm : route.realm);
      if (schema) { const r = schema.safeParse(a[i]); if (!r.success) fail('validation_failed', 'validation failed', r.error.issues); a[i] = r.data; }
      return fn(...a);
    };
    (impl as unknown as Record<string, unknown>)[name] = route.response === 'sse'
      ? async function* (...a: unknown[]) { yield* guarded(a) as AsyncIterable<unknown>; }
      : async (...a: unknown[]) => guarded(a);
  }
  return impl;
}
