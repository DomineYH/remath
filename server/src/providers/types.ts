// providersFor 계약(#55·#56·#57 공용). 바꾸려면 코디네이터 결정이 필요하다.
import type { Provider, ProviderId, Role } from '@remath/shared/engine';

/** pino 호환 최소 로거. 호출 로그 1줄(Q9)과 length 경고(Q24)용. */
export interface ProviderLog { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void }

export type RealProviderId = Exclude<ProviderId, 'mock'>;

/** 공급자·키로 실 어댑터를 만든다. role은 호출 로그용(설정 저장 시 listModels 검증에서도 넘긴다). */
export type ProvidersFor = (provider: RealProviderId, key: string, opts: { log: ProviderLog; role?: Role }) => Provider;
