// CLI 진입점 공통: 자기가 읽는 env 만 검증하고(#40 결정, B절), 실패는 메시지 한 줄 + 종료코드 1.
import { z } from 'zod';

export function readEnv<T extends z.ZodType>(schema: T, env: Record<string, string | undefined>): z.infer<T> {
  const e = schema.safeParse(env);
  if (!e.success) throw new Error('invalid environment:\n' + z.prettifyError(e.error));
  return e.data;
}

/** supabase-js 오류는 Error 가 아니라 {code, message} 객체다. */
export const main = (name: string, fn: () => Promise<unknown>) => fn().catch(err => {
  console.error(`${name} failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
  process.exit(1);
});
