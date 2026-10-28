// T-1 (d) SSE 프레임 왕복, F-22·F-24 claim_turn → record_turn 순서와 실패·끊김 정리, F-25 세션 시작 (Data API 가짜).
import { readFileSync } from 'node:fs';
import { TEMPLATES } from '@remath/prompts';
import * as S from '@remath/shared';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { sse } from '../../client/src/api/http.ts';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import type { Db } from './db.ts';
import { ApiFail } from './errors.ts';
import { frame, withTurn } from './turn.ts';

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

// ---- claim_turn → record_turn (F-22·F-24), start_session (F-25) --------------------------------

const gabriel = S.ScenarioInput.parse(JSON.parse(readFileSync(new URL('../../db/seed/scenarios/gabriel.json', import.meta.url), 'utf8')));
type Call = [string, unknown?];
const SID = '11111111-1111-4111-8111-111111111111', UID = '22222222-2222-4222-8222-222222222222', SC = '33333333-3333-4333-8333-333333333333';
interface FakeOpts {
  claim?: boolean; recordFails?: boolean; teacherTurns?: number; startDup?: boolean; started?: boolean;
  /** 호출마다 한 번: 여기서 기다리면 그 Data API 호출이 멈춘다(끼어들기 재현). */
  before?: (label: string, detail: unknown) => Promise<void> | void;
}

/**
 * Data API 가짜: 서버가 쓰는 from()/rpc() 빌더만. 필터는 무시하고 표마다 정해진 한 행으로 답한다.
 * sessions 행은 start_session rpc 가 끝나야 보인다(started) — rpc 한 번 = 트랜잭션 하나. 호출 순서를 calls 에 남긴다.
 */
function fakeDb(o: FakeOpts = {}) {
  const calls: Call[] = [];
  let started = o.started ?? true;
  const turns: Record<string, unknown>[] = [{ seq: 1, speaker: 'student', text: gabriel.translations.ko.greet, leverage: null, object: null, trigger: null, created_at: T0 }];
  for (let i = 0; i < (o.teacherTurns ?? 0); i++) turns.push({ seq: turns.length + 1, speaker: 'teacher', text: 'hm', leverage: 'Other', object: null, trigger: null, created_at: T0 });
  const translations = (['ko', 'en'] as const).map(lang => ({ lang, ...gabriel.translations[lang] }));
  const row = {
    id: SID, user_id: UID, scenario_id: SC, started_at: T0, ended_at: null, report: null, lang: 'ko', goal_reached: false, counts: {},
    progress: { mis: gabriel.internal.misconceptions.map(() => 0) }, turn_started_at: T0,
    user: { role: 'teacher', nickname: 'kim' }, turns, scenario: { ...gabriel, compiled_prompt: null, scenario_translations: translations },
  };
  const auth = { realm: 'teacher', expires_at: '2999-01-01T00:00:00Z', user: { id: UID, nickname: 'kim', role: 'teacher', pw_updated_at: T0, password_hash: 'h' } };
  const answer = (label: string, args: unknown) => {
    switch (label) {
      case 'claim_turn': return { data: o.claim ?? true, error: null };
      case 'record_turn': return o.recordFails ? { data: null, error: { message: 'boom' } } : { data: null, error: null };
      case 'teacher_scenarios': return { data: [{ id: SC }], error: null };
      case 'start_session':
        if (o.startDup) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "sessions_one_active"' } };
        started = true; void args; return { data: SID, error: null };
      case 'select auth_sessions': return { data: auth, error: null };
      case 'select scenarios': return { data: { lang: 'ko', internal: gabriel.internal, scenario_translations: translations }, error: null };
      case 'select sessions': return { data: started ? row : null, error: null };
      default: return { data: null, error: null };
    }
  };
  const call = (label: string, detail: unknown) => {
    const b = {
      select: (cols: string) => { if (label.startsWith('select ')) detail = cols; return b; },
      order: () => b, eq: () => b, is: () => b, not: () => b, single: () => b, maybeSingle: () => b,
      update: (v: unknown) => { label = label.replace('select', 'update'); detail = v; return b; },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => (async () => {
        await o.before?.(label, detail);
        calls.push([label, detail]);
        return answer(label, detail);
      })().then(res, rej),
    };
    return b;
  };
  const db = { rpc: (name: string, args: unknown) => call(name, args), from: (table: string) => call(`select ${table}`, undefined) } as unknown as Db;
  return { db, calls };
}
const log = { error: () => {} } as never;
const opts = (db: Db, signal?: AbortSignal) => ({ db, log, maxTurns: 40, timeoutMs: 120_000, templates: TEMPLATES, now: () => new Date(T0), signal });
const session = { id: SID, ended_at: null };
const run = (db: Db, text: string, signal?: AbortSignal) => withTurn(opts(db, signal), session, text, collect);
const labels = (calls: Call[]) => calls.map(c => c[0]);
const RELEASE: Call = ['update sessions', { turn_started_at: null }];

describe('withTurn: claim_turn → runTurn → record_turn once (F-22, F-24)', () => {
  it('claims, runs, records this turn with server seq in one record_turn, and never touches turn_started_at itself', async () => {
    const { db, calls } = fakeDb();
    const events = await run(db, '그림을 설명해 줄래?') as AdminSseEvent[];
    expect(events.map(e => e.type)).toEqual(['classification', 'student', 'done']);
    expect(labels(calls)).toEqual(['claim_turn', 'select sessions', 'record_turn']);
    const rec = calls[2][1] as { turns: { seq: number; speaker: string }[]; ended_at: null };
    expect(rec.turns.map(t => [t.seq, t.speaker])).toEqual([[2, 'teacher'], [3, 'student']]);
    expect(rec.ended_at).toBeNull();
    expect((events[2] as { turns: unknown[] }).turns).toHaveLength(2);
  });

  it('a failed record_turn: error event, nothing recorded, the turn is released', async () => {
    const { db, calls } = fakeDb({ recordFails: true });
    expect((await run(db, '그림을 설명해 줄래?')).at(-1)).toEqual({ type: 'error', code: 'provider_unavailable', message: expect.any(String), retryable: true });
    expect(calls.at(-1)).toEqual(RELEASE);
  });

  it('a client that leaves while the context is read: no record_turn, the claim is released', async () => {
    const ac = new AbortController();
    const { db, calls } = fakeDb({ before: label => { if (label === 'select sessions') ac.abort(); } });
    await expect(run(db, '그림을 설명해 줄래?', ac.signal)).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(labels(calls)).toEqual(['claim_turn', 'select sessions', 'update sessions']);
  });

  it('a client already gone before the claim: nothing is claimed', async () => {
    const ac = new AbortController(); ac.abort();
    const { db, calls } = fakeDb();
    await expect(run(db, 'hi', ac.signal)).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(calls).toEqual([]);
  });

  it('events abandoned before the first pull still release the claim', async () => {
    const { db, calls } = fakeDb();
    expect(await withTurn(opts(db), session, 'hi', async () => 'not pulled')).toBe('not pulled');
    expect(labels(calls)).toEqual(['claim_turn', 'select sessions', 'update sessions']);
  });

  it('refuses before streaming: lost claim = 409 turn_in_progress, turn limit = 422 after releasing the claim', async () => {
    const busy = fakeDb({ claim: false });
    await expect(run(busy.db, 'hi')).rejects.toMatchObject({ code: 'turn_in_progress', details: { turn_started_at: T0 } });
    expect(labels(busy.calls)).toEqual(['claim_turn', 'select sessions']);

    const full = fakeDb({ teacherTurns: 40 });
    const e = await run(full.db, 'hi').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiFail);
    expect(e).toMatchObject({ code: 'turn_limit_reached', details: { turn_count: 40, turn_limit: 40 } });
    expect(labels(full.calls)).toEqual(['claim_turn', 'select sessions', 'update sessions']);
    expect((await run(fakeDb({ teacherTurns: 40 }).db, 'END SESSION')).at(-1)).toMatchObject({ type: 'done', ended: true });
  });
});

// ---- HTTP: 끊김 감지 순서(실 소켓), 세션 시작 rpc --------------------------------------------------
const config = loadConfig({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'k', MOCK_LLM: '1' },
  p => readFileSync(new URL(p, new URL('../../', import.meta.url)), 'utf8'));
const TEACHER = { cookie: 'remath_teacher=tok', 'x-remath-realm': 'teacher', 'content-type': 'application/json' };
function gate() {
  let arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>(r => { arrive = r; }), opened = new Promise<void>(r => { release = r; });
  return { arrived, release, wait: () => { arrive(); return opened; } };
}

/** 실제로 listen 한 서버에 fetch 로 턴을 보내고, pauseAt 호출에서 멈춘 사이 클라이언트가 끊는다. 서버 쪽 소켓이 닫힌 뒤 재개한다. */
async function dropDuring(pauseAt: (label: string, detail: unknown) => boolean) {
  const g = gate();
  let armed = true;
  const fake = fakeDb({ before: (label, detail) => { if (armed && pauseAt(label, detail)) { armed = false; return g.wait(); } } });
  const app = await buildApp({ db: fake.db, config });
  const socketClosed = new Promise<void>(r => app.server.on('connection', s => s.on('close', () => r())));
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const ac = new AbortController();
  const req = fetch(`${url}/api/sessions/${SID}/turns`, { method: 'POST', headers: TEACHER, body: JSON.stringify({ text: '그림을 설명해 줄래?' }), signal: ac.signal }).catch(() => 'aborted');
  await g.arrived;
  ac.abort();
  expect(await req).toBe('aborted');
  await socketClosed;
  g.release();
  return { calls: fake.calls, close: () => app.close() };
}

describe('POST …/turns notices a dropped client before any awaited step (F-24)', () => {
  it('dropped during the context read: no record_turn, the claim is released', async () => {
    const r = await dropDuring((label, cols) => label === 'select sessions' && String(cols).includes('progress'));
    await vi.waitFor(() => expect(r.calls.at(-1)).toEqual(RELEASE));
    expect(labels(r.calls)).not.toContain('record_turn');
    await r.close();
  });
  it('dropped during the ownership read: the turn is never claimed', async () => {
    const r = await dropDuring((label, cols) => label === 'select sessions' && cols === 'id, ended_at');
    await vi.waitFor(() => expect(labels(r.calls)).toContain('select sessions'));
    await new Promise(res => setTimeout(res, 50));
    expect(labels(r.calls).filter(l => l !== 'select auth_sessions')).toEqual(['select sessions']);
    await r.close();
  });
});

describe('POST /api/sessions starts through one start_session rpc (F-25, D-14)', () => {
  const start = async (o: FakeOpts) => {
    const fake = fakeDb(o), app = await buildApp({ db: fake.db, config });
    return { ...fake, app, post: () => app.inject({ method: 'POST', url: '/api/sessions', headers: TEACHER, payload: { scenario_id: SC } }) };
  };
  it('201 SessionDetail with the greeting; session and greeting are written by the rpc alone', async () => {
    const s = await start({ started: false });
    const r = await s.post();
    expect(r.statusCode).toBe(201);
    expect(r.json().turns).toEqual([expect.objectContaining({ seq: 1, speaker: 'student', text: gabriel.translations.ko.greet })]);
    const rpc = s.calls.find(c => c[0] === 'start_session')!;
    expect(rpc[1]).toEqual({ p_user_id: UID, p_scenario_id: SC, p_lang: 'ko', p_progress: { mis: [0, 0, 0] }, p_counts: {}, p_greet: gabriel.translations.ko.greet });
    expect(labels(s.calls).filter(l => /^(insert|update|delete) /.test(l) || l === 'start_session')).toEqual(['start_session']);
  });
  it('a restore or a turn while the start is in flight sees no session (no greeting-less window)', async () => {
    const g = gate();
    const s = await start({ started: false, before: label => label === 'start_session' ? g.wait() : undefined });
    const starting = s.post();
    await g.arrived;
    expect((await s.app.inject({ url: '/api/sessions/current', headers: TEACHER })).json()).toBeNull();
    expect((await s.app.inject({ method: 'POST', url: `/api/sessions/${SID}/turns`, headers: TEACHER, payload: { text: 'hi' } })).statusCode).toBe(404);
    g.release();
    expect((await starting).statusCode).toBe(201);
    expect(labels(s.calls)).not.toContain('claim_turn');
  });
  it('a second active start (unique violation inside the rpc) is 409 session_active with the active id', async () => {
    const s = await start({ startDup: true });
    const r = await s.post();
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'session_active', details: { session_id: SID } });
  });
});
