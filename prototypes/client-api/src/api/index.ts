// 교체 지점 — HTTP↔목 전환은 여기 한 줄뿐이다. 화면 코드는 `Api` 타입과 `ApiError` 만 import 한다(`http.ts`·`mock/` 직접 import 금지, lint 규칙으로 막는다).
// 한 페이지는 realm 별로 인스턴스를 하나씩 둔다: 예비교사 화면 = createApi('teacher'), 관리자 화면(대화 테스트 포함) = createApi('admin').
import { createHttpApi } from './http.ts';
import { createMockApi } from './mock/index.ts';
import type { Api, ClientRealm } from './types.ts';
export { ApiError, type Api, type SseEvent } from './types.ts';

export function createApi(realm: ClientRealm, env: Record<string, string | undefined> = (import.meta as { env?: Record<string, string> }).env ?? {}): Api {
  return env.VITE_MOCK_API === '1' ? createMockApi({ realm }) : createHttpApi({ realm });
}
