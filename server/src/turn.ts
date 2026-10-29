// 턴 파이프라인 (F-22~F-25): claim_turn → runTurn(MOCK_LLM=1 이면 MOCK, 0 이면 ai_settings 의 실 공급자) → SSE 이벤트 → done 에서 record_turn 한 번. 실패·끊김은 발화 미기록 + 턴 해제.
import { compileScenario, type Templates } from '@remath/prompts';
import * as S from '@remath/shared';
import { AdapterError, END_SESSION_RE, mockProvider, runTurn, sessionReport, type BotCfg, type Bots, type Effort, type Provider, type Role, type Translation } from '@remath/shared/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import { must, type Db } from './db.ts';
import { ApiFail } from './errors.ts';
import type { ProvidersFor, RealProviderId } from './providers/types.ts';
import { open, VaultError } from './vault.ts';

export type AdminSseEvent = z.infer<typeof S.AdminSseEvent>;

/** `event: <type>\ndata: <json>\n\n`(F-23). JSON 은 줄바꿈을 \n 으로 이스케이프하므로 data 는 늘 한 줄이다. */
export const frame = ({ type, ...data }: AdminSseEvent) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/** 관리자 내부 상태(티켓 15): 진행 값 + 세션 전체의 마지막 트리거. 턴 SSE 의 state 이벤트와 GET /api/admin/sessions/:id 가 같이 쓴다. */
export const adminState = (s: { mis: number[]; counts: Record<string, number>; goal_reached: boolean }, turns: Pick<z.infer<typeof S.Turn>, 'trigger'>[]): z.infer<typeof S.AdminState> =>
  ({ mis: s.mis, counts: s.counts, goal_reached: s.goal_reached, last_trigger: [...turns].reverse().find(t => t.trigger)?.trigger ?? null });

/** 실 모드(MOCK_LLM=0) 의존성. 없으면 세 역할 모두 MOCK 이고 ai_settings 를 읽지 않는다(Q4). */
export interface Live { providersFor: ProvidersFor; secret: string }
export interface TurnOpts { db: Db; log: FastifyBaseLogger; maxTurns: number; timeoutMs: number; templates: Templates; now: () => Date; signal?: AbortSignal; live?: Live }

type Lang = z.infer<typeof S.Lang>;
type TurnCols = Omit<z.infer<typeof S.Turn>, 'created_at'>;
interface TurnContext {
  ended_at: string | null; lang: Lang; goal_reached: boolean; counts: Record<string, number>; progress: { mis: number[] };
  user: { role: 'teacher' | 'admin' }; turns: TurnCols[];
  scenario: Pick<z.infer<typeof S.ScenarioInput>, 'lang' | 'student_prefix' | 'internal' | 'classification'> & {
    compiled_prompt: z.infer<typeof S.Compiled> | null; scenario_translations: (z.infer<typeof S.Translation> & { lang: Lang })[];
  };
}
// 턴 파이프라인은 scenarios 원본(컴파일본·내부 설정)을 읽는다(ADR-0003 4항). 소유자 검사는 부른 쪽이 끝냈다.
const CONTEXT = 'ended_at, lang, goal_reached, counts, progress, user:users!inner(role), turns(seq, speaker, text, leverage, object, trigger), '
  + 'scenario:scenarios!inner(lang, student_prefix, internal, classification, compiled_prompt, scenario_translations(*))';

type Result<T> = { data: T; error: null } | { data: null; error: unknown };
/** supabase-js 는 {error} 를 돌려주지만 던질 수도 있다. 둘 다 {error} 로. error = "결과를 모른다"(커밋 뒤 응답만 잃었을 수 있음). */
const settle = <T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Result<T>> =>
  Promise.resolve(q).then(r => r as Result<T>, (error: unknown) => ({ data: null, error }));
/** release_turn(token): true = 우리가 풀었다(진행 중이던 우리 record_turn 은 이제 커밋할 수 없다), false = 토큰이 이미 없다, null = 결과를 모른다. */
async function releaseTurn(o: TurnOpts, id: string, token: string): Promise<boolean | null> {
  const r = await settle<boolean>(o.db.rpc('release_turn', { p_session_id: id, p_token: token }));
  if (r.error) { o.log.error({ err: r.error }, 'turn release outcome unknown'); return null; }
  return r.data === true;
}
/** 결과를 모를 때: 오류도 done 도 없이 스트림을 끝낸다. 클라이언트는 done 없는 끝 → GET /api/sessions/:id 로 맞춘다(ChatScreen syncDropped). */
async function* nothing(): AsyncGenerator<AdminSseEvent> { yield* []; }

/**
 * 한 턴의 수명(F-22·F-24): session_ended 409 → claim_turn 실패 409 turn_in_progress → 상한 422(END SESSION 은 예외) → use(이벤트).
 * 턴마다 토큰을 만들어 잡고(0003), record_turn·release_turn 은 그 토큰일 때만 DB 가 받는다: 시간 초과로 빼앗긴 느린 턴은 기록하지 못한다.
 * TURN_TIMEOUT_MS 는 잡는 순간부터 센다 — DB 가 고아로 보기 전에 서버가 먼저 포기한다.
 * 잡기가 정리되지 않고 끝나면(오류·시간 초과·끊김·이벤트를 끝까지 읽지 않음) 이 함수의 finally 가 release_turn 한다 — 생성기 finally 는
 * 첫 pull 전에는 돌지 않으므로 거기에 맡기지 않는다. release_turn 은 토큰 울타리라 결과를 모를 때 불러도 남의 턴을 풀지 않는다.
 * claim_turn 결과를 모르고 행에서 우리 토큰도 확인하지 못하면 release_turn 으로 울타리를 친다. 그것도 모르면 이벤트 없는 스트림.
 * o.signal(클라이언트 끊김)과 기한은 await 마다 다시 본다: 이미 끝났으면 잡지 않고, 잡은 뒤 끝났으면 해제하고 기록하지 않는다.
 */
export async function withTurn<T>(o: TurnOpts, s: { id: string; ended_at: string | null }, text: string, use: (events: AsyncGenerator<AdminSseEvent>) => Promise<T>): Promise<T> {
  const { db } = o, token = crypto.randomUUID();
  if (s.ended_at) throw new ApiFail('session_ended', 'session has ended');
  const deadline = AbortSignal.timeout(o.timeoutMs);
  const signal = AbortSignal.any([deadline, ...o.signal ? [o.signal] : []]);
  const gone = () => { if (signal.aborted) throw new ApiFail('provider_unavailable', deadline.aborted ? 'turn timed out' : 'client disconnected'); };
  gone();
  const claim = await settle<boolean>(db.rpc('claim_turn', { p_session_id: s.id, p_token: token, p_timeout_ms: o.timeoutMs }));
  if (claim.error) {   // 결과를 모른다: 행을 읽어 우리 토큰이면 잡은 것, 아니면 release 로 울타리
    o.log.error({ err: claim.error }, 'claim_turn outcome unknown');
    const r = await settle<{ turn_claim: string | null }>(db.from('sessions').select('turn_claim').eq('id', s.id).single());
    if (r.error || r.data?.turn_claim !== token) {
      if (await releaseTurn(o, s.id, token) === null) { o.log.error('turn claim unresolved: ending the stream without an event'); return use(nothing()); }
      throw claim.error;   // 잡지 못했거나, 잡은 것을 방금 풀었다
    }
  } else if (claim.data !== true) {
    const r = must(await db.from('sessions').select('turn_started_at').eq('id', s.id).single()) as { turn_started_at: string | null };
    throw new ApiFail('turn_in_progress', 'turn in progress', { turn_started_at: r.turn_started_at });
  }
  const done = { settled: false };   // true = 잡기가 이미 정리됐다(기록됨 또는 release 가 결과를 정함)
  try {
    gone();
    const c = must(await db.from('sessions').select(CONTEXT).eq('id', s.id).order('seq', { referencedTable: 'turns' }).single()) as unknown as TurnContext;
    gone();
    if (c.ended_at) throw new ApiFail('session_ended', 'session has ended');
    const turn_count = c.turns.filter(t => t.speaker === 'teacher').length;
    if (!END_SESSION_RE.test(text.trim()) && turn_count >= o.maxTurns) throw new ApiFail('turn_limit_reached', 'turn limit reached', { turn_count, turn_limit: o.maxTurns });
    return await use(stream({ ...o, signal }, s.id, token, c, text, done));
  } finally {
    if (!done.settled) await releaseTurn(o, s.id, token);   // 실패해도 남은 잡기는 claim_turn 이 timeout_ms 뒤 고아로 본다
  }
}

type Recorded = { ok: true; turns?: z.infer<typeof S.Turn>[]; report?: z.infer<typeof S.SessionReport> | null } | { ok: false; message: string } | { ok: 'unknown' };

/**
 * record_turn 한 번(DB 가 기한도 본다, 0005). 오류(결과 모름)면 먼저 release_turn(token) 으로 울타리를 친다 — 같은 행 잠금이라 진행 중인 record_turn 과 줄을 선다:
 * true = 기록 안 됨(그 record 는 앞으로도 커밋 못 함) → 재시도 가능. false = 토큰이 이미 없다 → 이번 턴의 행만 읽어
 * seq0..seq0+n-1 이 다 있고 seq0 이 우리 예비교사 문장이면 기록됨(DB 값으로 done), 아니면 빼앗겨 커밋 못 함 → 재시도 가능.
 * release 나 그 읽기의 결과도 모르면 'unknown': 이벤트 없이 끝낸다(클라이언트가 GET 으로 맞춘다).
 */
async function record(o: TurnOpts, id: string, token: string, args: Record<string, unknown>, seq0: number, n: number, text: string, ended: boolean): Promise<Recorded> {
  const r = await settle<boolean>(o.db.rpc('record_turn', { p_session_id: id, p_token: token, p_timeout_ms: o.timeoutMs, ...args }));
  if (r.data === true) return { ok: true };
  // false: 잡은 지 timeoutMs 를 넘겼거나(0005, 잡기는 아직 우리 것) 빼앗김·이미 끝남. 우리 것을 풀었으면 기한 초과 — 시간 초과 경로와 같은 오류.
  if (!r.error) return { ok: false, message: await releaseTurn(o, id, token) ? 'turn timed out' : 'turn expired' };
  o.log.error({ err: r.error }, 'record_turn outcome unknown');
  const released = await releaseTurn(o, id, token);
  if (released === null) return { ok: 'unknown' };
  if (released) return { ok: false, message: 'turn failed' };
  const c = await settle<{ ended_at: string | null; report: z.infer<typeof S.SessionReport> | null; turns: z.infer<typeof S.Turn>[] }>(
    o.db.from('sessions').select('ended_at, report, turns(seq, speaker, text, leverage, object, trigger, created_at)').eq('id', id).order('seq', { referencedTable: 'turns' }).single());
  if (c.error || !c.data) { o.log.error({ err: c.error }, 'turn outcome read failed'); return { ok: 'unknown' }; }
  if (ended) return c.data.ended_at ? { ok: true, report: c.data.report } : { ok: false, message: 'turn failed' };
  const mine = c.data.turns.filter(t => t.seq >= seq0 && t.seq < seq0 + n);
  return mine.length === n && mine[0].speaker === 'teacher' && mine[0].text === text ? { ok: true, turns: mine } : { ok: false, message: 'turn failed' };
}

/** 실 모드에서 역할에 공급자·암호문·모델이 없거나(Q4) 암호문을 풀지 못함(Q18). 턴은 기록하지 않고 재시도해도 소용없다. */
class Unconfigured extends Error {
  constructor(readonly role: Role, readonly code: 'ai_not_configured' | 'vault_decrypt_failed') { super(code); }
}
type AiRow = { role: Role; key_source: Role | 'own'; provider: RealProviderId | null; key_ciphertext: string | null; model: string | null; effort: Effort | null };

/** Q3·Q19·Q21: ai_settings 3행을 턴마다 한 번 읽어 Bots. 공유 역할은 출처 행의 provider·암호문(저장 시 복사 없음), model·effort 는 자기 행. */
async function liveBots(o: TurnOpts, live: Live, pass: (p: Provider) => Provider): Promise<Bots> {
  const rows = must(await o.db.from('ai_settings').select('role, key_source, provider, key_ciphertext, model, effort')) as AiRow[];
  const by = new Map(rows.map(r => [r.role, r]));
  const bot = (role: Role): BotCfg => {
    const r = by.get(role), src = r && (r.key_source === 'own' ? r : by.get(r.key_source));
    if (!r?.model || !src?.provider || !src.key_ciphertext) throw new Unconfigured(role, 'ai_not_configured');
    let key: string;
    try { key = open(src.key_ciphertext, live.secret); } catch (err) { throw err instanceof VaultError ? new Unconfigured(role, err.code) : err; }
    return { provider: pass(live.providersFor(src.provider, key, { log: o.log, role })), model: r.model, effort: r.effort };
  };
  return { student: bot('student'), analysis: bot('analysis'), mentor: bot('mentor') };
}

/**
 * 실패 → SSE error(Q7). 기한은 오류 이름이 아니라 우리 signal 의 reason 으로 안다(어댑터 오류는 늘 AdapterError).
 * 어댑터 오류는 code·retryable 을 그대로 쓰고, 메시지는 고정 문자열이다: AdapterError.message 는 공급자 문구(마스킹된 키 포함)를 담을 수 있다.
 */
function failure(err: unknown, signal: AbortSignal): AdminSseEvent {
  if (signal.aborted && (signal.reason as Error | undefined)?.name === 'TimeoutError') return { type: 'error', code: 'provider_unavailable', message: 'turn timed out', retryable: true };
  if (err instanceof Unconfigured) return { type: 'error', code: 'provider_unavailable', message: 'ai not configured', retryable: false };
  if (err instanceof AdapterError && err.code === 'provider_rejected') return { type: 'error', code: 'provider_rejected', message: 'provider rejected the request', retryable: err.retryable };
  if (err instanceof AdapterError && err.code === 'provider_unavailable') return { type: 'error', code: 'provider_unavailable', message: 'turn failed', retryable: err.retryable };
  return { type: 'error', code: 'provider_unavailable', message: 'turn failed', retryable: true };
}

async function* stream(o: TurnOpts & { signal: AbortSignal }, id: string, token: string, c: TurnContext, text: string, done: { settled: boolean }): AsyncGenerator<AdminSseEvent> {
  const sc = c.scenario, history = c.turns, { signal } = o;
  const tr = (lang: Lang) => sc.scenario_translations.find(t => t.lang === lang)!;
  const pass = (p: Provider): Provider => ({ ...p, complete: req => p.complete({ ...req, signal }) });   // F-24: 어댑터 호출마다 signal
  const mock = { provider: pass(mockProvider), model: 'mock', effort: null };
  const criteria = sc.classification.leverage.length ? sc.classification : null;
  const state = { mis: c.progress.mis, counts: c.counts, goalReached: c.goal_reached, takeOverCount: history.filter(t => t.trigger === S.TRIGGER.takingOver).length };
  const seq0 = (history.at(-1)?.seq ?? 0) + 1;
  const pending: TurnCols[] = [{ seq: seq0, speaker: 'teacher', text, leverage: null, object: null, trigger: null }];
  const add = (t: Pick<TurnCols, 'speaker' | 'text'> & Partial<TurnCols>) => pending.push({ leverage: null, object: null, trigger: null, ...t, seq: seq0 + pending.length });
  try {
    const bots = o.live ? await liveBots(o, o.live, pass) : { student: mock, analysis: mock, mentor: mock };
    for await (const ev of runTurn({ bots, compiled: sc.compiled_prompt ?? compileScenario(sc, tr(sc.lang), sc.lang, o.templates), criteria,
      tr: tr(c.lang) as Translation, lang: c.lang, state, history, text })) {
      if (ev.type === 'classification') { if (ev.cls) { Object.assign(pending[0], ev.cls); yield { type: 'classification', ...ev.cls }; } }
      else if (ev.type === 'student') { if (ev.final) add({ speaker: 'student', text: ev.text }); yield ev; }
      else if (ev.type === 'trigger') { add({ speaker: 'mentor', text: '', trigger: ev.trigger }); yield ev; }
      else if (ev.type === 'mentor') { if (ev.final) pending[pending.length - 1].text = ev.text; yield ev; }
      else {
        signal.throwIfAborted();   // 기한(잡은 순간부터)·끊김 뒤에는 기록하지 않는다
        const at = o.now().toISOString(), turns = ev.ended ? [] : pending;
        const report = ev.ended ? sessionReport(sc.classification.leverage, history, c.goal_reached, ev.summary ?? null) : null;
        const rec = await record(o, id, token, {
          p_turns: turns, p_progress: { mis: ev.state.mis }, p_counts: ev.state.counts, p_goal_reached: ev.state.goalReached,
          p_ended_at: ev.ended ? at : null, p_report: report,
        }, seq0, turns.length, text, ev.ended);
        if (rec.ok === 'unknown') { o.log.error({ session_id: id }, 'turn outcome unknown: ending the stream without a terminal event'); return; }
        done.settled = true;   // 기록됨·울타리에 막힘·release 가 정함: 어느 쪽이든 우리 잡기는 이미 없다
        if (!rec.ok) { yield { type: 'error', code: 'provider_unavailable', message: rec.message, retryable: true }; return; }
        // 관리자 세션만, done 직전 1회(티켓 15)
        if (c.user.role === 'admin') yield { type: 'state', ...adminState({ mis: ev.state.mis, counts: ev.state.counts, goal_reached: ev.state.goalReached }, [...history, ...turns]) };
        // ponytail: 정상 기록이면 created_at 은 서버 시각이다(record_turn 은 boolean, DB 값과 ms 차). 맞춰 읽은 경우만 DB 값.
        yield ev.ended ? { type: 'done', ended: true, report: rec.report !== undefined ? rec.report : report }
          : { type: 'done', ended: false, turns: rec.turns ?? turns.map(t => ({ ...t, created_at: at })) };
      }
    }
  } catch (err) {
    // 키·암호문·발화는 로그에 넣지 않는다: 어댑터 오류는 공급자·코드·상태만(Q9).
    o.log.error(err instanceof AdapterError ? { provider: err.provider, code: err.code, status: err.status } : err instanceof Unconfigured ? { role: err.role, code: err.code } : { err }, 'turn failed');
    yield failure(err, signal);
  }
}

/** F-24: 기동 시 진행 중 턴(표시·토큰)을 일괄 해제한다(이전 프로세스가 남긴 고아). 끝난 세션은 건드리지 않는다. */
export async function releaseTurns(db: Db) {
  must(await db.from('sessions').update({ turn_started_at: null, turn_claim: null }).not('turn_started_at', 'is', null).is('ended_at', null));
}
