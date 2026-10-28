// 목 API 의 공용 문맥: 한 인스턴스(실 하나)의 저장소·시계·쿠키 상자·로그인 확인. 책임별 파일(auth·projection·sessions·scenarios·admin)이 이것만 받는다.
import type { Templates } from '@remath/prompts';
import { ERROR_STATUS, type ErrorCode } from '@remath/shared';
import { ApiError, type ClientRealm } from '../types.ts';
import type { Db, Storage, Store, UserRow } from './store.ts';

export type Jar = { teacher: string | null; admin: string | null };
export interface MockOptions {
  realm: ClientRealm;
  store?: Store;                                   // 한 페이지의 teacher/admin 두 인스턴스는 같은 store 를 공유한다
  storage?: Storage;
  now?: () => string;
  /** 예비교사 발화 수 상한(D-15). 생략하면 40. 테스트가 작게 주입해 422 를 만든다. */
  turnLimit?: number;
  /** 검수 c7·게시 컴파일에 쓸 템플릿. 생략하면 번들 TEMPLATES. 테스트가 두 판이 어긋난 템플릿을 넣어 c7 FAIL 을 만든다(서버는 디스크의 .md). */
  templates?: Templates;
  /** 관리자 초기 비밀번호. 생략하면 VITE_MOCK_ADMIN_PASSWORD. 비었으면 관리자 로그인은 늘 401(G-33). */
  adminPassword?: string;
  /** 이 브라우저의 쿠키 상자. 생략하면 저장소의 login(이 브라우저). 테스트는 따로 넘겨 같은 서버의 다른 브라우저를 흉내 낸다. */
  cookies?: Jar;
}

export const fail = (code: ErrorCode, message: string = code, details?: unknown): never => {
  throw new ApiError(ERROR_STATUS[code], { error: { code, message, details } });
};

export interface Ctx {
  o: MockOptions; db: Db; jar: Jar;
  now: () => string; uuid: () => string; save: () => void;
  turnLimit: number; templates: Templates; adminPassword: string | undefined;
  /** 이 브라우저의 그 실 로그인 사용자(쿠키 = 실별 토큰). 없으면 401. */
  who: (realm: ClientRealm) => UserRow;
}
