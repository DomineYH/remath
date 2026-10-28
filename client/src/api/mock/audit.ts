// 감사 helper (티켓 20, D-21). 본 쓰기가 성공한 뒤에만 부르고, 부른 쪽이 store.save() 를 한 번 한다.
// meta 에 비밀번호·해시·토큰·발화 원문을 넣지 않는다.
import type * as S from '@remath/shared';
import type { z } from 'zod';
import type { Db } from './store.ts';

export interface AuditInput { actor_id: string | null; action: z.infer<typeof S.AuditAction>; target: string; meta: Record<string, unknown> }

export function audit(db: Db, now: string, e: AuditInput): void {
  db.audit_log.push({ id: crypto.randomUUID(), ...e, created_at: now });
}
