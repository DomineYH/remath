// T-1 (d) SSE 프레임 왕복, F-22·F-24 claim_turn → record_turn 순서와 실패 정리 (Data API 가짜).
import { readFileSync } from 'node:fs';
import { TEMPLATES } from '@remath/prompts';
import * as S from '@remath/shared';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { sse } from '../../client/src/api/http.ts';
import type { Db } from './db.ts';
import { ApiFail } from './errors.ts';
import { frame, openTurn } from './turn.ts';

type AdminSseEvent = z.infer<typeof S.AdminSseEvent>;
const T0 = '2026-10-28T03:00:00.123456+00:00';
const report: z.infer<typeof S.SessionReport> = { total: 1, reached: true, verdict: 'clean', rows: [{ name: 'Eliciting', desc: 'd', count: 1, turns: [{ seq: 2, text: '줄\n바꿈 "따옴표"' }] }], summary: '요약\n둘째 줄' };
const teacherEvents: AdminSseEvent[] = [
  { type: 'classification', leverage: 'Eliciting', object: null },
  { type: 'student', text: '음…\n잘 모르겠어요.', final: true },
  { type: 'trigger', trigger: 3 },
  { type: 'mentor', text: 'event: fake\ndata: {}\n\n', final: true },
  { type: 'done', ended: false, turns: [{ seq: 2, speaker: 'teacher', text: 'hi', leverage: 'Eliciting', object: null, trigger: null, created_at: T0 }] },
  { type: 'done', ended: true, report },
  { type: 'done', ended: true, report: null },
  { type: 'error', code: 'provider_unavailable', message: 'turn failed', retryable: true },
];
const stateEvent: AdminSseEvent = { type: 'state', mis: [2, 1], counts: { Eliciting: 3 }, goal_reached: false, last_trigger: 1 };

/** 프레임을 한 바이트씩 잘라 보내도 같은 이벤트가 나와야 한다(청크 경계가 프레임 중간에 걸린다). */
const response = (events: AdminSseEvent[]) => {
  const bytes = new TextEncoder().encode(events.map(frame).join(''));
  let i = 0;
  return new Response(new ReadableStream({ pull(c) { if (i < bytes.length) c.enqueue(bytes.slice(i, ++i)); else c.close(); } }));
};
const collect = async (it: AsyncIterable<unknown>) => { const out = []; for await (const x of it) out.push(x); return out; };

describe('TurnEvent → SSE frame round-trips through client sse() (T-1 d)', () => {
  it('teacher schema: every event comes back unchanged', async () => {
    expect(await collect(sse(Promise.resolve(response(teacherEvents)), S.SseEvent))).toEqual(teacherEvents);
  });
  it('admin schema: state comes back too', async () => {
    const events = [...teacherEvents.slice(0, 4), stateEvent, teacherEvents[4]];
    expect(await collect(sse(Promise.resolve(response(events)), S.AdminSseEvent))).toEqual(events);
  });
  it('a frame is exactly `event: <type>\\ndata: <json>\\n\\n`', () => {
    expect(frame({ type: 'trigger', trigger: 1 })).toBe('event: trigger\ndata: {"trigger":1}\n\n');
  });
});

// ---- claim_turn → record_turn (F-22·F-24) --------------------------------------------------

const gabriel = S.ScenarioInput.parse(JSON.parse(readFileSync(new URL('../../db/seed/scenarios/gabriel.json', import.meta.url), 'utf8')));
type Call = [string, unknown?];

/** Data API 가짜: rpc 두 개와, 턴이 읽는 sessions 한 행·쓰는 turn_started_at 해제만. 호출 순서를 calls 에 남긴다. */
function fakeDb(o: { claim?: boolean; recordFails?: boolean; teacherTurns?: number } = {}) {
  const calls: Call[] = [];
  const history: Record<string, unknown>[] = [{ seq: 1, speaker: 'student', text: gabriel.translations.ko.greet, leverage: null, object: null, trigger: null }];
  for (let i = 0; i < (o.teacherTurns ?? 0); i++) history.push({ seq: history.length + 1, speaker: 'teacher', text: 'hm', leverage: 'Other', object: null, trigger: null });
  const row = {
    id: 'sid', ended_at: null, lang: 'ko', goal_reached: false, counts: {}, progress: { mis: gabriel.internal.misconceptions.map(() => 0) }, turn_started_at: T0,
    user: { role: 'teacher' }, turns: history,
    scenario: { ...gabriel, status: 'draft', compiled_prompt: null, scenario_translations: (['ko', 'en'] as const).map(lang => ({ lang, ...gabriel.translations[lang] })) },
  };
  const ok = (data: unknown) => Promise.resolve({ data, error: null });
  const db = {
    rpc: (name: string, args: unknown) => {
      calls.push([name, args]);
      if (name === 'claim_turn') return ok(o.claim ?? true);
      return o.recordFails ? Promise.resolve({ data: null, error: { message: 'boom' } }) : ok(null);
    },
    from: (table: string) => {
      let op = 'select', values: unknown;
      const b = {
        select: () => b, order: () => b, eq: () => b, single: () => b, maybeSingle: () => b,
        update: (v: unknown) => { op = 'update'; values = v; return b; },
        then: (res: (v: unknown) => unknown) => { calls.push([`${op} ${table}`, values]); return ok(op === 'select' ? row : null).then(res); },
      };
      return b;
    },
  } as unknown as Db;
  return { db, calls };
}
const log = { error: () => {} } as never;
const opts = (db: Db, signal?: AbortSignal) => ({ db, log, maxTurns: 40, timeoutMs: 120_000, templates: TEMPLATES, now: () => new Date(T0), signal });
const session = { id: 'sid', ended_at: null };

describe('openTurn: claim_turn → runTurn → record_turn once (F-22, F-24)', () => {
  it('claims, runs, records this turn with server seq in one record_turn, and never touches turn_started_at itself', async () => {
    const { db, calls } = fakeDb();
    const events = await collect(await openTurn(opts(db), session, '그림을 설명해 줄래?'));
    expect(events.map(e => (e as AdminSseEvent).type)).toEqual(['classification', 'student', 'done']);
    expect(calls.map(c => c[0])).toEqual(['claim_turn', 'select sessions', 'record_turn']);
    const rec = calls[2][1] as { turns: { seq: number; speaker: string }[]; ended_at: null };
    expect(rec.turns.map(t => [t.seq, t.speaker])).toEqual([[2, 'teacher'], [3, 'student']]);
    expect(rec.ended_at).toBeNull();
    expect((events[2] as { turns: unknown[] }).turns).toHaveLength(2);
  });

  it('a failed record_turn or a dropped client: error event, nothing recorded, the turn is released', async () => {
    const failing = fakeDb({ recordFails: true });
    const events = await collect(await openTurn(opts(failing.db), session, '그림을 설명해 줄래?'));
    expect(events.at(-1)).toEqual({ type: 'error', code: 'provider_unavailable', message: expect.any(String), retryable: true });
    expect(failing.calls.at(-1)).toEqual(['update sessions', { turn_started_at: null }]);

    const ac = new AbortController(), dropped = fakeDb();
    const gen = await openTurn(opts(dropped.db, ac.signal), session, '그림을 설명해 줄래?');
    ac.abort();
    expect((await collect(gen)).at(-1)).toMatchObject({ type: 'error' });
    expect(dropped.calls.map(c => c[0])).toEqual(['claim_turn', 'select sessions', 'update sessions']);
  });

  it('refuses before streaming: lost claim = 409 turn_in_progress, turn limit = 422 after releasing the claim', async () => {
    const busy = fakeDb({ claim: false });
    await expect(openTurn(opts(busy.db), session, 'hi')).rejects.toMatchObject({ code: 'turn_in_progress', details: { turn_started_at: T0 } });
    expect(busy.calls.map(c => c[0])).toEqual(['claim_turn', 'select sessions']);

    const full = fakeDb({ teacherTurns: 40 });
    const e = await openTurn(opts(full.db), session, 'hi').catch(x => x);
    expect(e).toBeInstanceOf(ApiFail);
    expect(e).toMatchObject({ code: 'turn_limit_reached', details: { turn_count: 40, turn_limit: 40 } });
    expect(full.calls.map(c => c[0])).toEqual(['claim_turn', 'select sessions', 'update sessions']);
    expect((await collect(await openTurn(opts(fakeDb({ teacherTurns: 40 }).db), session, 'END SESSION'))).at(-1)).toMatchObject({ type: 'done', ended: true });
  });
});
