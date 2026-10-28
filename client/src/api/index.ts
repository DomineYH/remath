// 교체 지점 — HTTP↔목 전환은 createApi 의 한 줄뿐이다. 화면 코드는 `Api` 타입·`ApiError`·`createApi` 만 import 한다(`http.ts`·`mock/` 직접 import 금지, lint 규칙).
// 한 페이지는 realm 별로 인스턴스를 하나씩 둔다(`../apis.ts`): 예비교사 화면 = createApi('teacher'), 관리자 화면(대화 테스트 포함) = createApi('admin').
import { createHttpApi } from './http.ts';
import type { AdminApi, Api, ClientRealm } from './types.ts';
export { ApiError, type AdminApi, type AdminSseEvent, type Api, type ClientRealm, type SseEvent } from './types.ts';

type Env = Record<string, string | undefined>;
// Bundle boundary (A-4): in a non-mock build this condition is a constant false, so the bundler drops the import and emits no mock chunk.
const mock = import.meta.env.VITE_MOCK_API === '1' ? await import('./mock/index.ts') : undefined;

const mockOrThrow = () => mock ?? (() => { throw new Error('mock API not bundled: run with VITE_MOCK_API=1'); })();

export function createApi(realm: 'teacher', env?: Env): Api;
export function createApi(realm: 'admin', env?: Env): AdminApi;
export function createApi(realm: ClientRealm, env: Env = import.meta.env): Api | AdminApi {
  return env.VITE_MOCK_API === '1' ? mockOrThrow().createMockApi({ realm }) : createHttpApi({ realm });
}
