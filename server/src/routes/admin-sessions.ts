// 관리자 기록 (E-19, G-26, D-16): 모든 사용자의 세션 목록·상세(+내부 상태)·CSV 스트리밍. 읽기만.
import { Readable } from 'node:stream';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import type { Deps, Handlers } from '../app.ts';
import { csv } from '../csv.ts';
import { must, type Db } from '../db.ts';
import { ApiFail } from '../errors.ts';
import { SESSION_DETAIL_SELECT, SESSION_SELECT, sessionDetail, sessionRow, type SessionDbRow } from '../projection.ts';
import { adminState } from '../turn.ts';
import { idParam } from './admin-scenarios.ts';

type Filter = z.infer<typeof S.SessionFilter>;
const PAGE = 100;

/**
 * 필터에 맞는 세션을 최신순(started_at, id 내림차순)으로 PAGE 개씩, turns 는 seq 순. Data API 의 max-rows 에 잘리지 않는다.
 * 키셋(마지막 행 다음부터)이라 읽는 사이 새 세션이 생겨도 행이 겹치거나 빠지지 않는다.
 */
async function* pages(db: Db, cols: string, f: Filter): AsyncGenerator<SessionDbRow[]> {
  for (let last: SessionDbRow | undefined; ;) {
    let q = db.from('sessions').select(cols);
    if (f.user_id) q = q.eq('user_id', f.user_id);
    if (f.scenario_id) q = q.eq('scenario_id', f.scenario_id);
    if (last) q = q.or(`started_at.lt."${last.started_at}",and(started_at.eq."${last.started_at}",id.lt.${last.id})`);
    const rows = must(await q.order('started_at', { ascending: false }).order('id', { ascending: false })
      .order('seq', { referencedTable: 'turns' }).limit(PAGE)) as unknown as SessionDbRow[];
    if (rows.length) yield rows;
    if (rows.length < PAGE) return;
    last = rows.at(-1);
  }
}

export function adminSessionHandlers({ db, config }: Deps): Handlers {
  return {
    'GET /api/admin/sessions': async req => {
      const out: z.infer<typeof S.SessionRow>[] = [];
      for await (const page of pages(db, `${SESSION_SELECT}, turns(speaker)`, req.query as Filter)) out.push(...page.map(sessionRow));
      return out;
    },

    /** state 는 턴 SSE 의 state 이벤트와 같은 함수(adminState). 남의 세션도 본다. */
    'GET /api/admin/sessions/:id': async req => {
      const s = must(await db.from('sessions').select(`${SESSION_DETAIL_SELECT}, progress, counts`).eq('id', idParam(req))
        .order('seq', { referencedTable: 'turns' }).maybeSingle()) as unknown as Required<SessionDbRow> | null;
      if (!s) throw new ApiFail('not_found', 'session not found');
      return { ...sessionDetail(s, config.env.MAX_TURNS), state: adminState({ mis: s.progress.mis, counts: s.counts, goal_reached: s.goal_reached }, s.turns) };
    },

    /** 첫 쪽은 머리말을 보내기 전에 읽는다: 거기서 실패하면 깨진 CSV 대신 일반 500. 그 뒤의 실패는 응답을 끊는다. */
    'GET /api/admin/sessions.csv': async (req, reply) => {
      const it = pages(db, SESSION_DETAIL_SELECT, req.query as Filter), first = await it.next();
      const rest = async function* () { if (!first.done) yield first.value; yield* it; };
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="sessions.csv"')
        .send(Readable.from(csv(rest())));
    },
  };
}
