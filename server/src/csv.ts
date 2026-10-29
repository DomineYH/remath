// CSV (G-26, C13): 목 csv() 와 바이트가 같다 — BOM, 헤더, 1행 = 1발화, 모든 칸 따옴표 + "" 이스케이프, CRLF, 끝 줄바꿈 없음.
// 쪽(page)마다 줄을 내보내는 생성기라 응답으로 그대로 흘려보낸다. 파일로 남기지 않는다(PRD 9절).
import { sessionRow, type SessionDbRow } from './projection.ts';

const HEADER = 'session_id,started_at,nickname,scenario,lang,seq,speaker,text,leverage,object,trigger';
const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** pages = 최신 세션순, 세션 안의 turns 는 seq 순. */
export async function* csv(pages: AsyncIterable<SessionDbRow[]>): AsyncGenerator<string> {
  yield '﻿' + HEADER;
  for await (const page of pages) {
    const lines = page.flatMap(s => {
      const r = sessionRow(s);
      return s.turns.map(t => [s.id, s.started_at, r.nickname, r.scenario_name, s.lang, t.seq, t.speaker, t.text, t.leverage, t.object, t.trigger].map(cell).join(','));
    });
    if (lines.length) yield '\r\n' + lines.join('\r\n');
  }
}
