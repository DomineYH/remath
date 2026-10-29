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

/**
 * 목록 읽기: Data API 한 요청은 max-rows(Supabase 기본 1000)에서 말없이 잘린다. 같은 쿼리를 range 쪽으로 빈 쪽이 나올 때까지 이어 읽는다
 * (받은 행 수만큼 넘기므로 max-rows 가 pageSize 보다 작아도 빠지지 않는다). query 는 매번 새 빌더를 만들고, 정렬의 마지막 키는 기본 키로
 * 둔다(동률이 있어도 쪽이 결정적). 한 행 읽기와 세션 하나의 발화(턴 상한 이하)에는 쓰지 않는다.
 */
export async function readAll<T>(query: () => { range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }> }, pageSize = 1000): Promise<T[]> {
  const out: T[] = [];
  for (;;) {
    const page = must(await query().range(out.length, out.length + pageSize - 1)) as T[];
    if (!page.length) return out;
    out.push(...page);
  }
}
