// HTTP 구현 — 라우트 표(API_ROUTES)만으로 38개 메서드를 만든다. 2단계에서 서버가 생기면 그대로 쓴다.
// 쿠키는 브라우저가 붙인다(same-origin). `any` 라우트는 `X-Remath-Realm` 헤더로 어느 쿠키로 행동할지 알린다(SPEC 3절 가정).
import * as S from '@remath/shared';
import { routes } from '@remath/shared';
import { API_ROUTES, ApiError, type AdminSseEvent, type Api, type ClientRealm, type SseEvent } from './types.ts';

export interface HttpOptions { realm: ClientRealm; fetch?: typeof fetch; base?: string }

export function createHttpApi(o: HttpOptions): Api {
  const f = o.fetch ?? globalThis.fetch, base = o.base ?? '';
  const api: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(API_ROUTES)) {
    const [method, path] = key.split(' ') as [string, string];
    const route = routes.find(r => r.method === method && r.path === path)!;
    api[name] = (...args: unknown[]) => {
      let p = path;
      if (p.includes(':')) p = p.replace(/:\w+/, encodeURIComponent(String(args.shift())));
      const payload = args.shift() as Record<string, string> | undefined;
      if (route.query && payload) p += '?' + new URLSearchParams(Object.entries(payload).filter(([, v]) => v != null));
      const init: RequestInit = { method, credentials: 'same-origin', headers: { accept: route.response === 'sse' ? 'text/event-stream' : '*/*' } };
      if (route.body) init.body = JSON.stringify(payload), (init.headers as Record<string, string>)['content-type'] = 'application/json'; // CSRF: JSON 강제(SPEC 2절)
      if (route.realm === 'any') (init.headers as Record<string, string>)['x-remath-realm'] = o.realm;
      const res = f(base + p, init).then(async r => { if (!r.ok) throw new ApiError(r.status, S.ApiError.parse(await r.json())); return r; });
      if (route.response === 'sse') return sse(res, o.realm === 'admin' ? S.AdminSseEvent : S.SseEvent);
      return res.then(r => route.response === 'none' ? undefined : route.response === 'csv' ? r.blob() : r.json());
    };
  }
  return api as unknown as Api;
}

/** `event: <type>\ndata: <json>\n\n` 프레임 → SseEvent. id·retry 없음, 재접속 없음(끊기면 GET /api/sessions/:id 로 복구). 관리자 실은 `state` 도 받는다(티켓 15). */
export async function* sse(res: Promise<Response>, schema: typeof S.SseEvent | typeof S.AdminSseEvent = S.SseEvent): AsyncGenerator<SseEvent | AdminSseEvent> {
  const reader = (await res).body!.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += done ? '' : dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const get = (k: string) => frame.split('\n').filter(l => l.startsWith(k + ':')).map(l => l.slice(k.length + 1).trimStart()).join('\n');
      if (get('event')) yield schema.parse({ type: get('event'), ...JSON.parse(get('data')) });
    }
    if (done) return;
  }
}
