// Data API 클라이언트 하나(ADR-0003 3항, E-18): 서비스 키, 세션 저장·갱신 없음.
import { createClient } from '@supabase/supabase-js';

export const createDb = (url: string, serviceKey: string) =>
  createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
export type Db = ReturnType<typeof createDb>;

/** supabase-js 는 throw 하지 않고 {error} 를 돌려준다. 예상한 오류(unique 위반 등)는 부른 쪽이 먼저 본다. */
export function must<T>(r: { data: T; error: unknown }): T {
  if (r.error) throw r.error;
  return r.data;
}
