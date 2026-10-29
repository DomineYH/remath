// 감사 helper (G-27, 티켓 20): 본 작업이 끝난 뒤 별도 insert, 실패는 서버 로그만.
// meta 에 비밀번호·해시·토큰·키·발화 원문을 넣지 않는다.
import type { AuditAction } from '@remath/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import type { Db } from './db.ts';

export interface AuditInput { actor_id: string | null; action: z.infer<typeof AuditAction>; target: string; meta: Record<string, unknown> }

export async function audit(db: Db, log: Pick<FastifyBaseLogger, 'error'>, e: AuditInput): Promise<void> {
  const { error } = await db.from('audit_log').insert(e);
  if (error) log.error({ err: error, action: e.action }, 'audit insert failed');
}
