// T-1 (d) SSE 프레임 왕복, F-22·F-24 claim_turn → record_turn 순서와 실패·끊김 정리, F-25 세션 시작 (Data API 가짜).
import { readFileSync } from 'node:fs';
import { TEMPLATES } from '@remath/prompts';
import * as S from '@remath/shared';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { sse } from '../../client/src/api/http.ts';
import { AdapterError, mockProvider } from '@remath/shared/engine';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import type { Db } from './db.ts';
import { ApiFail } from './errors.ts';
import { providersFor } from './providers/index.ts';
import { fakeFetch, sseResponse, sseText } from './providers/testkit.ts';
import type { ProvidersFor } from './providers/types.ts';
import { frame, withTurn } from './turn.ts';
import { seal } from './vault.ts';

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
  claim?: boolean; teacherTurns?: number; startDup?: boolean; started?: boolean;
  /** claim_turn 이 커밋한 뒤 응답만 잃는다(결과 모름). */
  claimLost?: boolean;
  /** record_turn: before = 쓰기 전 오류, after = 커밋 뒤 응답만 잃음, fenced = 울타리에 막혀 false,
   *  inflight = 응답은 잃었는데 트랜잭션이 아직 진행 중 — 행 잠금 순서(inflightOrder)대로 release_turn 앞이나 뒤에 커밋을 시도한다. */
  record?: 'before' | 'after' | 'fenced' | 'inflight';
  inflightOrder?: 'release-first' | 'record-first';
  /** release_turn 의 결과를 모른다(쓰지 않고 응답 오류). */
  releaseLost?: boolean;
  /** 결과를 맞추는 읽기(select turn_claim …)가 실패한다. */
  readFails?: boolean;
  /** 호출마다 한 번: 여기서 기다리면 그 Data API 호출이 멈춘다(끼어들기 재현). */
  before?: (label: string, detail: unknown) => Promise<void> | void;
  /** ai_settings 행(실 모드). */
  ai?: AiRow[];
}

/**
 * Data API 가짜: 서버가 쓰는 from()/rpc() 빌더만. 필터는 무시하고 표마다 정해진 한 행으로 답한다.
 * sessions 행은 start_session rpc 가 끝나야 보인다(started) — rpc 한 번 = 트랜잭션 하나.
 * claim_turn/record_turn/release_turn 은 0003 처럼 turn_claim 토큰을 지킨다. 호출 순서를 calls 에 남긴다.
 */
function fakeDb(o: FakeOpts = {}) {
  const calls: Call[] = [];
  let started = o.started ?? true;
  const turns: Record<string, unknown>[] = [{ seq: 1, speaker: 'student', text: gabriel.translations.ko.greet, leverage: null, object: null, trigger: null, created_at: T0 }];
  for (let i = 0; i < (o.teacherTurns ?? 0); i++) turns.push({ seq: turns.length + 1, speaker: 'teacher', text: 'hm', leverage: 'Other', object: null, trigger: null, created_at: T0 });
  const translations = (['ko', 'en'] as const).map(lang => ({ lang, ...gabriel.translations[lang] }));
  const row = {
    id: SID, user_id: UID, scenario_id: SC, started_at: T0, ended_at: null, report: null, lang: 'ko', goal_reached: false, counts: {},
    progress: { mis: gabriel.internal.misconceptions.map(() => 0) }, turn_started_at: T0, turn_claim: null as string | null,
    user: { role: 'teacher', nickname: 'kim' }, turns, scenario: { ...gabriel, compiled_prompt: null, scenario_translations: translations },
  };
  const auth = { realm: 'teacher', expires_at: '2999-01-01T00:00:00Z', user: { id: UID, nickname: 'kim', role: 'teacher', pw_updated_at: T0, password_hash: 'h' } };
  const lost = { data: null, error: { message: 'fetch failed' } };
  let claimedAt = 0;
  /** 0005 record_turn: 토큰·종료·잡은 뒤 p_timeout_ms 이내인지를 행 잠금 아래에서 보고 쓴다(늦으면 잡기는 그대로). */
  const commit = (a: Record<string, unknown>) => {
    if (row.turn_claim !== a.p_token || row.ended_at || Date.now() - claimedAt > (a.p_timeout_ms as number)) return false;
    turns.push(...(a.p_turns as Record<string, unknown>[]).map(t => ({ ...t, created_at: T1 })));
    Object.assign(row, { turn_claim: null, ended_at: a.p_ended_at, report: a.p_report });
    return true;
  };
  let inflight: (() => boolean) | null = null;
  const answer = (label: string, args: unknown) => {
    const a = args as Record<string, unknown>;
    switch (label) {
      case 'claim_turn':
        if (o.claim === false) return { data: false, error: null };
        row.turn_claim = a.p_token as string; claimedAt = Date.now();
        return o.claimLost ? lost : { data: true, error: null };
      case 'record_turn': {
        if (o.record === 'before') return lost;
        if (o.record === 'inflight') { inflight = () => commit(a); return lost; }
        if (o.record === 'fenced') { row.turn_claim = 'taken-over'; return { data: false, error: null }; }
        const ok = commit(a);
        return o.record === 'after' ? lost : { data: ok, error: null };
      }
      case 'release_turn': {
        if (o.releaseLost) return lost;
        if (inflight && o.inflightOrder === 'record-first') { inflight(); inflight = null; }   // release 가 잠금을 기다린 사이 커밋
        const ok = row.turn_claim === a.p_token;
        if (ok) row.turn_claim = null;
        return { data: ok, error: null };
      }
      case 'select ai_settings': return { data: structuredClone(o.ai ?? []), error: null };
      case 'teacher_scenarios': return { data: [{ id: SC }], error: null };
      case 'start_session':
        if (o.startDup) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "sessions_one_active"' } };
        started = true; void args; return { data: SID, error: null };
      case 'select auth_sessions': return { data: auth, error: null };
      case 'select scenarios': return { data: { lang: 'ko', internal: gabriel.internal, scenario_translations: translations }, error: null };
      case 'select sessions':
        if (o.readFails && String(args).startsWith('turn_claim')) return lost;
        return { data: started ? structuredClone(row) : null, error: null };
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
  /** 진행 중이던 record_turn 이 나중에 커밋을 시도한다(release 가 먼저 잠금을 잡았으면 토큰이 없어 실패해야 한다). */
  const lateCommit = () => { const ok = inflight?.() ?? null; inflight = null; return ok; };
  return { db, calls, row, turns, lateCommit };
}
const log = { error: () => {} } as never;
const opts = (db: Db, signal?: AbortSignal) => ({ db, log, maxTurns: 40, timeoutMs: 120_000, templates: TEMPLATES, now: () => new Date(T0), signal });
const session = { id: SID, ended_at: null };
const run = (db: Db, text: string, signal?: AbortSignal) => withTurn(opts(db, signal), session, text, collect);
const labels = (calls: Call[]) => calls.map(c => c[0]);
const T1 = '2026-10-28T03:00:01.5+00:00';

describe('withTurn: claim_turn → runTurn → record_turn once (F-22, F-24)', () => {
  it('claims, runs, records this turn with server seq in one record_turn, and needs no release', async () => {
    const { db, calls } = fakeDb();
    const events = await run(db, '그림을 설명해 줄래?') as AdminSseEvent[];
    expect(events.map(e => e.type)).toEqual(['classification', 'student', 'student', 'done']);
    expect(labels(calls)).toEqual(['claim_turn', 'select sessions', 'record_turn']);
    const rec = calls[2][1] as { p_turns: { seq: number; speaker: string }[]; p_ended_at: null };
    expect(rec.p_turns.map(t => [t.seq, t.speaker])).toEqual([[2, 'teacher'], [3, 'student']]);
    expect(rec.p_ended_at).toBeNull();
    expect((events[3] as { turns: unknown[] }).turns).toHaveLength(2);
  });

  it('student streams final:false then final:true over SSE; only the final text is recorded (ADR-0004)', async () => {
    const { db, calls } = fakeDb();
    const events = await run(db, '그림을 설명해 줄래?') as AdminSseEvent[];
    const said = events.filter(e => e.type === 'student');
    expect(said.map(e => e.final)).toEqual([false, true]);
    const rec = calls.find(c => c[0] === 'record_turn')![1] as { p_turns: { speaker: string; text: string }[] };
    expect(rec.p_turns.filter(t => t.speaker === 'student').map(t => t.text)).toEqual([said[1].text]);
  });

  it('claim, record and release carry the same fresh token', async () => {
    const { db, calls } = fakeDb({ record: 'before' });
    await run(db, '그림을 설명해 줄래?');
    const tokens = calls.filter(c => ['claim_turn', 'record_turn', 'release_turn'].includes(c[0])).map(c => (c[1] as { p_token: string }).p_token);
    expect(tokens).toHaveLength(3);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a client that leaves while the context is read: no record_turn, the claim is released', async () => {
    const ac = new AbortController();
    const { db, calls } = fakeDb({ before: label => { if (label === 'select sessions') ac.abort(); } });
    await expect(run(db, '그림을 설명해 줄래?', ac.signal)).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(labels(calls)).toEqual(['claim_turn', 'select sessions', 'release_turn']);
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
    expect(labels(calls)).toEqual(['claim_turn', 'select sessions', 'release_turn']);
  });

  it('refuses before streaming: lost claim = 409 turn_in_progress, turn limit = 422 after releasing the claim', async () => {
    const busy = fakeDb({ claim: false });
    await expect(run(busy.db, 'hi')).rejects.toMatchObject({ code: 'turn_in_progress', details: { turn_started_at: T0 } });
    expect(labels(busy.calls)).toEqual(['claim_turn', 'select sessions']);

    const full = fakeDb({ teacherTurns: 40 });
    const e = await run(full.db, 'hi').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiFail);
    expect(e).toMatchObject({ code: 'turn_limit_reached', details: { turn_count: 40, turn_limit: 40 } });
    expect(labels(full.calls)).toEqual(['claim_turn', 'select sessions', 'release_turn']);
    expect((await run(fakeDb({ teacherTurns: 40 }).db, 'END SESSION')).at(-1)).toMatchObject({ type: 'done', ended: true });
  });
});

describe('withTurn: deadline from the claim, fenced record, unknown RPC outcomes (F-24, rev 3)', () => {
  const lastErr = (evs: unknown[]) => evs.at(-1) as { type: string; retryable?: boolean; message?: string };
  it('a context read that outlives TURN_TIMEOUT_MS (counted from the claim) is refused: no record, released', async () => {
    const { db, calls } = fakeDb({ before: label => label === 'select sessions' ? new Promise(r => setTimeout(r, 60)) : undefined });
    await expect(withTurn({ ...opts(db), timeoutMs: 30 }, session, 'hi', collect)).rejects.toMatchObject({ code: 'provider_unavailable', message: 'turn timed out' });
    expect(labels(calls)).toEqual(['claim_turn', 'select sessions', 'release_turn']);
  });
  it('a record fenced off by the DB (claim taken over or session ended): error, retryable; release by token finds no claim of ours', async () => {
    const { db, calls } = fakeDb({ record: 'fenced' });
    expect(lastErr(await run(db, '그림을 설명해 줄래?'))).toMatchObject({ type: 'error', retryable: true, message: 'turn expired' });
    expect(labels(calls).slice(-2)).toEqual(['record_turn', 'release_turn']);
  });
  it('record_turn carries TURN_TIMEOUT_MS so the DB refuses a late write (0005)', async () => {
    const { db, calls } = fakeDb();
    await withTurn({ ...opts(db), timeoutMs: 4321 }, session, 'hi', collect);
    expect(calls.find(c => c[0] === 'record_turn')![1]).toMatchObject({ p_timeout_ms: 4321 });
  });
  it('review probe: persistence (150 ms) outlives the deadline (100 ms) → the DB refuses, no teacher row, no done, same error as a timeout, released', async () => {
    const f = fakeDb({ before: label => label === 'record_turn' ? new Promise(r => setTimeout(r, 150)) : undefined });
    const evs = await withTurn({ ...opts(f.db), timeoutMs: 100 }, session, '그림을 설명해 줄래?', collect) as AdminSseEvent[];
    expect(evs.map(e => e.type)).not.toContain('done');
    expect(evs.at(-1)).toEqual({ type: 'error', code: 'provider_unavailable', message: 'turn timed out', retryable: true });
    expect(f.turns.filter(t => t.speaker === 'teacher')).toEqual([]);
    expect(labels(f.calls).slice(-2)).toEqual(['record_turn', 'release_turn']);
    expect(f.row.turn_claim).toBeNull();
  });
  it('claim_turn committed but its response was lost: the row shows our token, so the turn goes on and records once', async () => {
    const { db, calls } = fakeDb({ claimLost: true });
    expect((await run(db, '그림을 설명해 줄래?')).at(-1)).toMatchObject({ type: 'done', ended: false });
    expect(labels(calls)).toEqual(['claim_turn', 'select sessions', 'select sessions', 'record_turn']);
    expect(calls[1][1]).toBe('turn_claim');
  });
  it('claim_turn outcome unknown and the reconcile read fails: release by token, then fail', async () => {
    const { db, calls } = fakeDb({ claimLost: true, readFails: true });
    await expect(run(db, 'hi')).rejects.toMatchObject({ message: 'fetch failed' });
    expect(labels(calls)).toEqual(['claim_turn', 'select sessions', 'release_turn']);
  });
  it('record_turn committed but its response was lost: release says the claim is gone, the exact rows are there → done with them', async () => {
    const { db, calls } = fakeDb({ record: 'after' });
    const evs = await run(db, '그림을 설명해 줄래?');
    expect(evs.at(-1)).toMatchObject({ type: 'done', ended: false, turns: [
      expect.objectContaining({ seq: 2, speaker: 'teacher', text: '그림을 설명해 줄래?', created_at: T1 }), expect.objectContaining({ seq: 3, speaker: 'student' })] });
    expect(labels(calls)).toEqual(['claim_turn', 'select sessions', 'record_turn', 'release_turn', 'select sessions']);
  });
  it('END SESSION committed but its response was lost: done ended with the stored report', async () => {
    const { db } = fakeDb({ record: 'after' });
    expect((await run(db, 'END SESSION')).at(-1)).toMatchObject({ type: 'done', ended: true, report: expect.objectContaining({ verdict: expect.any(String) }) });
  });
  it('record_turn failed before writing: release clears our claim (true) → retryable error, no read', async () => {
    const { db, calls } = fakeDb({ record: 'before' });
    expect(lastErr(await run(db, '그림을 설명해 줄래?'))).toMatchObject({ type: 'error', retryable: true });
    expect(labels(calls)).toEqual(['claim_turn', 'select sessions', 'record_turn', 'release_turn']);
  });

  // ---- review REV 3 probes -----------------------------------------------------------------------
  it('probe 1a: record still in flight, release wins the row lock → retryable error, and the late commit is fenced off', async () => {
    const f = fakeDb({ record: 'inflight', inflightOrder: 'release-first' });
    expect(lastErr(await run(f.db, '그림을 설명해 줄래?'))).toMatchObject({ type: 'error', retryable: true });
    expect(f.lateCommit()).toBe(false);
    expect(f.turns.filter(t => t.speaker === 'teacher')).toEqual([]);
  });
  it('probe 1b: record still in flight, it wins the row lock → release=false, the exact rows are read → done, nothing to retry', async () => {
    const f = fakeDb({ record: 'inflight', inflightOrder: 'record-first' });
    expect((await run(f.db, '그림을 설명해 줄래?')).at(-1)).toMatchObject({ type: 'done', ended: false, turns: [expect.objectContaining({ seq: 2, speaker: 'teacher' }), expect.objectContaining({ seq: 3 })] });
    expect(f.turns.filter(t => t.speaker === 'teacher')).toHaveLength(1);
  });
  it('probe 2: record outcome unknown and release outcome unknown → no error and no done: the stream just ends', async () => {
    const { db } = fakeDb({ record: 'before', releaseLost: true });
    const evs = await run(db, '그림을 설명해 줄래?') as AdminSseEvent[];
    expect(evs.map(e => e.type)).toEqual(['classification', 'student', 'student']);
  });
  it('probe 2 for the claim: claim outcome unknown, not confirmed by the read, release unknown → no events at all', async () => {
    const { db, calls } = fakeDb({ claimLost: true, readFails: true, releaseLost: true });
    expect(await run(db, 'hi')).toEqual([]);
    expect(labels(calls)).toEqual(['claim_turn', 'select sessions', 'release_turn']);
  });
  it('probe 3: a later turn B lands before A reconciles → A\'s done holds only A\'s rows (seq0..seq0+n-1)', async () => {
    const f = fakeDb({ record: 'after', before: label => {
      if (label === 'release_turn') f.turns.push({ seq: 4, speaker: 'teacher', text: 'B', leverage: null, object: null, trigger: null, created_at: T1 }, { seq: 5, speaker: 'student', text: 'b', leverage: null, object: null, trigger: null, created_at: T1 });
    } });
    const done = (await run(f.db, '그림을 설명해 줄래?')).at(-1) as { type: string; turns: { seq: number }[] };
    expect(done.type).toBe('done');
    expect(done.turns.map(t => t.seq)).toEqual([2, 3]);
  });
  it('claim gone but the rows at seq0 are another holder\'s turn → not ours: retryable error', async () => {
    const f = fakeDb({ record: 'before', before: label => {
      if (label === 'release_turn') {
        f.row.turn_claim = 'someone-else';
        f.turns.push({ seq: 2, speaker: 'teacher', text: 'other tab', leverage: null, object: null, trigger: null, created_at: T1 }, { seq: 3, speaker: 'student', text: 's', leverage: null, object: null, trigger: null, created_at: T1 });
      }
    } });
    expect(lastErr(await run(f.db, '그림을 설명해 줄래?'))).toMatchObject({ type: 'error', retryable: true });
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
    await vi.waitFor(() => expect(r.calls.at(-1)?.[0]).toBe('release_turn'));
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

describe('POST …/end goes through the same claim → record_turn(token) fence (F-25)', () => {
  it('claims with a token and records the end with it; a fenced end is 502 provider_unavailable', async () => {
    const ok = fakeDb(), app = await buildApp({ db: ok.db, config });
    const r = await app.inject({ method: 'POST', url: `/api/sessions/${SID}/end`, headers: { cookie: TEACHER.cookie, 'x-remath-realm': 'teacher' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ verdict: expect.any(String) });
    const tok = (l: string) => (ok.calls.find(c => c[0] === l)![1] as { p_token: string }).p_token;
    expect(tok('record_turn')).toBe(tok('claim_turn'));
    expect((ok.calls.find(c => c[0] === 'record_turn')![1] as { p_turns: unknown[] }).p_turns).toEqual([]);

    const fenced = fakeDb({ record: 'fenced' }), app2 = await buildApp({ db: fenced.db, config });
    const f = await app2.inject({ method: 'POST', url: `/api/sessions/${SID}/end`, headers: { cookie: TEACHER.cookie, 'x-remath-realm': 'teacher' } });
    expect(f.statusCode).toBe(502);

    const unknown = fakeDb({ record: 'before', releaseLost: true }), app3 = await buildApp({ db: unknown.db, config });
    const u = await app3.inject({ method: 'POST', url: `/api/sessions/${SID}/end`, headers: { cookie: TEACHER.cookie, 'x-remath-realm': 'teacher' } });
    expect(u.statusCode).toBe(502);   // no invented report; the screen's end() refetches in finally
    expect(u.json().error.message).toMatch(/unknown/);
  });
});

describe('unknown outcome over HTTP: the SSE ends with no terminal event (client then GETs the session, ChatScreen syncDropped)', () => {
  it('200 text/event-stream; the client sse() sees the turn events but neither done nor error', async () => {
    const f = fakeDb({ record: 'before', releaseLost: true }), app = await buildApp({ db: f.db, config });
    const r = await app.inject({ method: 'POST', url: `/api/sessions/${SID}/turns`, headers: TEACHER, payload: { text: '그림을 설명해 줄래?' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/event-stream/);
    const evs = await collect(sse(Promise.resolve(new Response(r.body)), S.SseEvent)) as AdminSseEvent[];
    expect(evs.map(e => e.type)).toEqual(['classification', 'student', 'student']);
  });
});

// ---- 실 모드(#57): ai_settings → 복호 → providersFor → Bots, 오류 매핑(Q3·Q4·Q7·Q18·Q19·Q21) --------------------
interface AiRow { role: string; key_source: string; provider: string | null; key_ciphertext: string | null; model: string | null; effort: string | null }
const SECRET = Buffer.alloc(32, 7).toString('base64');
const own = (role: string, provider: string, key: string, model: string, effort: string | null = null): AiRow =>
  ({ role, key_source: 'own', provider, key_ciphertext: seal(key, SECRET), model, effort });
/** 학생 openai 자기 키, 분석 anthropic 자기 키, 멘토는 학생 키를 쓴다(행에는 provider·암호문이 없다: 출처 행에서 읽어야 한다). */
const AI: AiRow[] = [own('student', 'openai', 'sk-student-1', 'gpt-s', 'low'), own('analysis', 'anthropic', 'sk-ant-2', 'claude-a'),
  { role: 'mentor', key_source: 'student', provider: null, key_ciphertext: null, model: 'gpt-m', effort: 'high' }];
/** 가짜 providersFor: 호출마다 (역할·공급자·키·모델·effort)를 남기고, fail 이 있으면 던지고, 없으면 mockProvider 로 답한다. */
function fakeProviders(fail?: (provider: string, signal?: AbortSignal) => Promise<never>) {
  const called: { role?: string; provider: string; key: string; model: string; effort: string | null }[] = [];
  const providersFor: ProvidersFor = (provider, key, { role }) => ({
    id: provider, listModels: async () => [],
    async *complete(req) {
      called.push({ role, provider, key, model: req.model, effort: req.effort ?? null });
      if (fail) await fail(provider, req.signal);
      yield* mockProvider.complete(req);
    },
  });
  return { called, providersFor };
}
const lines: unknown[][] = [];
const liveLog = { error: (...a: unknown[]) => lines.push(a), warn: (...a: unknown[]) => lines.push(a), info: (...a: unknown[]) => lines.push(a) } as never;
const live = (db: Db, p: ReturnType<typeof fakeProviders>) => ({ ...opts(db), log: liveLog, live: { providersFor: p.providersFor, secret: SECRET } });

describe('withTurn live mode (MOCK_LLM=0): Bots from ai_settings, read once per turn', () => {
  it('each role calls with its row\'s model and effort; the mentor sharing the student key calls with the student provider and key', async () => {
    const p = fakeProviders();
    const a = fakeDb({ ai: AI }), b = fakeDb({ ai: AI });
    expect((await withTurn(live(a.db, p), session, '그림을 설명해 줄래?', collect)).at(-1)).toMatchObject({ type: 'done', ended: false });
    expect((await withTurn(live(b.db, p), session, '힌트 좀 줄래?', collect)).at(-1)).toMatchObject({ type: 'done', ended: false });
    expect(labels(a.calls).filter(l => l === 'select ai_settings')).toHaveLength(1);
    expect(p.called).toEqual(expect.arrayContaining([
      { role: 'student', provider: 'openai', key: 'sk-student-1', model: 'gpt-s', effort: 'low' },
      { role: 'analysis', provider: 'anthropic', key: 'sk-ant-2', model: 'claude-a', effort: null },
      { role: 'mentor', provider: 'openai', key: 'sk-student-1', model: 'gpt-m', effort: 'high' },
    ]));
    expect(new Set(p.called.map(c => c.role))).toEqual(new Set(['student', 'analysis', 'mentor']));
  });
  const notConfigured = { type: 'error', code: 'provider_unavailable', message: 'ai not configured', retryable: false };
  it('a role whose key row has no ciphertext → ai not configured (not retryable): no provider call, no turns recorded, claim released', async () => {
    const p = fakeProviders(), f = fakeDb({ ai: [AI[0], AI[1], { ...AI[0], role: 'mentor', key_ciphertext: null }] });
    expect(await withTurn(live(f.db, p), session, '그림을 설명해 줄래?', collect)).toEqual([notConfigured]);
    expect(p.called).toEqual([]);
    expect(labels(f.calls)).toEqual(['claim_turn', 'select sessions', 'select ai_settings', 'release_turn']);
    expect(f.turns.filter(t => t.speaker === 'teacher')).toEqual([]);
    expect(f.row.turn_claim).toBeNull();
  });
  it('a ciphertext the vault cannot open → ai not configured, logged as vault_decrypt_failed (no key, no ciphertext in the log)', async () => {
    lines.length = 0;
    const bad = seal('sk-ant-2', Buffer.alloc(32, 9).toString('base64'));
    const p = fakeProviders(), f = fakeDb({ ai: [AI[0], { ...AI[1], key_ciphertext: bad }, AI[2]] });
    expect(await withTurn(live(f.db, p), session, '그림을 설명해 줄래?', collect)).toEqual([notConfigured]);
    expect(labels(f.calls)).not.toContain('record_turn');
    const logged = JSON.stringify(lines);
    expect(logged).toContain('vault_decrypt_failed');
    expect(logged).not.toContain('sk-');
    expect(logged).not.toContain(bad);
  });
  const failWith = (status: number) => fakeProviders(async provider => {
    throw new AdapterError(provider as never, status >= 500 ? 'provider_unavailable' : 'provider_rejected', `${status} Incorrect API key provided: sk-stu****ent1`, { status, retryable: status >= 500 });
  });
  it('adapter 401 → provider_rejected, not retryable; the provider message (masked key) is not sent or logged', async () => {
    lines.length = 0;
    const f = fakeDb({ ai: AI });
    const evs = await withTurn(live(f.db, failWith(401)), session, '그림을 설명해 줄래?', collect);
    expect(evs).toEqual([{ type: 'error', code: 'provider_rejected', message: 'provider rejected the request', retryable: false }]);
    expect(labels(f.calls)).not.toContain('record_turn');
    expect(f.row.turn_claim).toBeNull();
    expect(JSON.stringify(lines)).not.toMatch(/Incorrect|sk-/);
  });
  it('adapter 500 → provider_unavailable, retryable; nothing recorded', async () => {
    const f = fakeDb({ ai: AI });
    expect(await withTurn(live(f.db, failWith(500)), session, '그림을 설명해 줄래?', collect))
      .toEqual([{ type: 'error', code: 'provider_unavailable', message: 'turn failed', retryable: true }]);
    expect(labels(f.calls)).not.toContain('record_turn');
  });
  it('a request error inside a 200 stream (real adapter) → provider_rejected, not retryable (Q7)', async () => {
    const midRejected = {
      openai: sseText(`event: error
data: {"type":"error","sequence_number":1,"code":"invalid_api_key","message":"Incorrect API key provided: sk-stu****ent1","param":null}`),
      anthropic: sseText(`event: error
data: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`),
      gemini: sseText(`data: {"error":{"code":403,"message":"denied","status":"PERMISSION_DENIED"}}`),
    };
    const real: ProvidersFor = (provider, key, o) => providersFor(provider, key, { ...o, fetch: fakeFetch(() => sseResponse(midRejected[provider])).fetch } as typeof o);
    const f = fakeDb({ ai: AI });
    expect(await withTurn({ ...live(f.db, fakeProviders()), live: { providersFor: real, secret: SECRET } }, session, '그림을 설명해 줄래?', collect))
      .toEqual([{ type: 'error', code: 'provider_rejected', message: 'provider rejected the request', retryable: false }]);
    expect(labels(f.calls)).not.toContain('record_turn');
  });
  it('the turn deadline hit inside a provider call → turn timed out, retryable (detected from our signal, not the error name)', async () => {
    const p = fakeProviders((provider, signal) => new Promise((_, rej) => signal!.addEventListener('abort', () =>
      rej(new AdapterError(provider as never, 'provider_unavailable', 'aborted', { retryable: false })))));
    const f = fakeDb({ ai: AI });
    expect(await withTurn({ ...live(f.db, p), timeoutMs: 30 }, session, '그림을 설명해 줄래?', collect))
      .toEqual([{ type: 'error', code: 'provider_unavailable', message: 'turn timed out', retryable: true }]);
    expect(f.row.turn_claim).toBeNull();
  });
  it('mock mode never reads ai_settings', async () => {
    const { db, calls } = fakeDb({ ai: AI });
    await run(db, '그림을 설명해 줄래?');
    expect(labels(calls)).not.toContain('select ai_settings');
  });
});

describe('POST …/turns with MOCK_LLM=0 takes the injected providersFor and the vault secret from config', () => {
  it('a turn over HTTP calls the real-provider factory for each role it needs', async () => {
    const liveConfig = loadConfig({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'k', MOCK_LLM: '0', KEY_VAULT_SECRET: SECRET },
      p => readFileSync(new URL(p, new URL('../../', import.meta.url)), 'utf8'));
    const p = fakeProviders(), f = fakeDb({ ai: AI }), app = await buildApp({ db: f.db, config: liveConfig, providersFor: p.providersFor });
    const r = await app.inject({ method: 'POST', url: `/api/sessions/${SID}/turns`, headers: TEACHER, payload: { text: '그림을 설명해 줄래?' } });
    const evs = await collect(sse(Promise.resolve(new Response(r.body)), S.SseEvent)) as AdminSseEvent[];
    expect(evs.at(-1)).toMatchObject({ type: 'done', ended: false });
    expect(p.called.map(c => [c.role, c.key])).toEqual([['analysis', 'sk-ant-2'], ['student', 'sk-student-1']]);
  });
  it('POST …/end keeps Q7\'s code: the analysis provider rejects the summary → provider_rejected; unavailable stays provider_unavailable; nothing recorded', async () => {
    const liveConfig = loadConfig({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'k', MOCK_LLM: '0', KEY_VAULT_SECRET: SECRET },
      p => readFileSync(new URL(p, new URL('../../', import.meta.url)), 'utf8'));
    for (const [status, code] of [[401, 'provider_rejected'], [503, 'provider_unavailable']] as const) {
      const p = fakeProviders(async provider => {
        if (provider === 'anthropic') throw new AdapterError('anthropic', code, `${status} no`, { status, retryable: status >= 500 });
        return undefined as never;
      });
      const f = fakeDb({ ai: AI }), app = await buildApp({ db: f.db, config: liveConfig, providersFor: p.providersFor });
      const r = await app.inject({ method: 'POST', url: `/api/sessions/${SID}/end`, headers: { cookie: TEACHER.cookie, 'x-remath-realm': 'teacher' } });
      expect(p.called.map(c => c.role)).toContain('analysis');
      expect(r.statusCode).toBe(502);
      expect(r.json().error.code).toBe(code);
      expect(labels(f.calls)).not.toContain('record_turn');
    }
  });
});
