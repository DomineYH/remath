// 턴 파이프라인 (F-22~F-25): claim_turn → runTurn(MOCK_LLM) → SSE 이벤트 → done 에서 record_turn 한 번. 실패·끊김은 발화 미기록 + 턴 해제.
import { compileScenario, type Templates } from '@remath/prompts';
import * as S from '@remath/shared';
import { END_SESSION_RE, mockProvider, runTurn, sessionReport, type Provider, type Translation } from '@remath/shared/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import { must, type Db } from './db.ts';
import { ApiFail } from './errors.ts';

export type AdminSseEvent = z.infer<typeof S.AdminSseEvent>;

/** `event: <type>\ndata: <json>\n\n`(F-23). JSON 은 줄바꿈을 \n 으로 이스케이프하므로 data 는 늘 한 줄이다. */
export const frame = ({ type, ...data }: AdminSseEvent) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

export interface TurnOpts { db: Db; log: FastifyBaseLogger; maxTurns: number; timeoutMs: number; templates: Templates; now: () => Date; signal?: AbortSignal }

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

/**
 * 스트림 전 검사(F-22 순서): session_ended 409 → claim_turn 실패 409 turn_in_progress → 상한 422(END SESSION 은 예외) → 이벤트 생성기.
 * 생성기는 done 에서 record_turn 한 번으로 이번 턴을 기록하고, 그 전에 끝나면(오류·시간 초과·끊김) 발화 없이 턴만 해제한다.
 */
export async function openTurn(o: TurnOpts, s: { id: string; ended_at: string | null }, text: string): Promise<AsyncGenerator<AdminSseEvent>> {
  const { db } = o;
  if (s.ended_at) throw new ApiFail('session_ended', 'session has ended');
  if (!must(await db.rpc('claim_turn', { session_id: s.id, timeout_ms: o.timeoutMs }))) {
    const r = must(await db.from('sessions').select('turn_started_at').eq('id', s.id).single()) as { turn_started_at: string | null };
    throw new ApiFail('turn_in_progress', 'turn in progress', { turn_started_at: r.turn_started_at });
  }
  const release = async () => {
    const { error } = await db.from('sessions').update({ turn_started_at: null }).eq('id', s.id);
    if (error) o.log.error({ err: error }, 'turn release failed');   // 남은 플래그는 claim_turn 이 timeout_ms 뒤 고아로 본다
  };
  let c: TurnContext;
  try {
    c = must(await db.from('sessions').select(CONTEXT).eq('id', s.id).order('seq', { referencedTable: 'turns' }).single()) as unknown as TurnContext;
    if (c.ended_at) throw new ApiFail('session_ended', 'session has ended');
    const turn_count = c.turns.filter(t => t.speaker === 'teacher').length;
    if (!END_SESSION_RE.test(text.trim()) && turn_count >= o.maxTurns) throw new ApiFail('turn_limit_reached', 'turn limit reached', { turn_count, turn_limit: o.maxTurns });
  } catch (e) { await release(); throw e; }
  return stream(o, s.id, c, text, release);
}

async function* stream(o: TurnOpts, id: string, c: TurnContext, text: string, release: () => Promise<void>): AsyncGenerator<AdminSseEvent> {
  const sc = c.scenario, history = c.turns;
  const tr = (lang: Lang) => sc.scenario_translations.find(t => t.lang === lang)!;
  const signal = AbortSignal.any([AbortSignal.timeout(o.timeoutMs), ...o.signal ? [o.signal] : []]);
  const pass = (p: Provider): Provider => ({ ...p, complete: req => p.complete({ ...req, signal }) });   // F-24: 어댑터 호출마다 signal
  const bots = { student: pass(mockProvider), analysis: pass(mockProvider), mentor: pass(mockProvider), model: 'mock' };
  const criteria = sc.classification.leverage.length ? sc.classification : null;
  const state = { mis: c.progress.mis, counts: c.counts, goalReached: c.goal_reached, takeOverCount: history.filter(t => t.trigger === S.TRIGGER.takingOver).length };
  const seq0 = (history.at(-1)?.seq ?? 0) + 1;
  const pending: TurnCols[] = [{ seq: seq0, speaker: 'teacher', text, leverage: null, object: null, trigger: null }];
  const add = (t: Pick<TurnCols, 'speaker' | 'text'> & Partial<TurnCols>) => pending.push({ leverage: null, object: null, trigger: null, ...t, seq: seq0 + pending.length });
  let recorded = false;
  try {
    for await (const ev of runTurn({ bots, compiled: sc.compiled_prompt ?? compileScenario(sc, tr(sc.lang), sc.lang, o.templates), criteria,
      tr: tr(c.lang) as Translation, lang: c.lang, state, history, text })) {
      if (ev.type === 'classification') { if (ev.cls) { Object.assign(pending[0], ev.cls); yield { type: 'classification', ...ev.cls }; } }
      else if (ev.type === 'student') { add({ speaker: 'student', text: ev.text }); yield { type: 'student', text: ev.text, final: true }; }
      else if (ev.type === 'trigger') { add({ speaker: 'mentor', text: '', trigger: ev.trigger }); yield ev; }
      else if (ev.type === 'mentor') { pending[pending.length - 1].text = ev.text; yield { type: 'mentor', text: ev.text, final: true }; }
      else {
        signal.throwIfAborted();   // 시간 초과·끊김 뒤에는 기록하지 않는다
        const at = o.now().toISOString(), turns = ev.ended ? [] : pending;
        const report = ev.ended ? sessionReport(sc.classification.leverage, history, c.goal_reached, ev.summary ?? null) : null;
        must(await o.db.rpc('record_turn', {
          session_id: id, turns, progress: { mis: ev.state.mis }, counts: ev.state.counts, goal_reached: ev.state.goalReached,
          ended_at: ev.ended ? at : null, report,
        }));
        recorded = true;
        if (c.user.role === 'admin') {   // 관리자 세션만, done 직전 1회(티켓 15)
          const last_trigger = [...history, ...turns].reverse().find(t => t.trigger)?.trigger ?? null;
          yield { type: 'state', mis: ev.state.mis, counts: ev.state.counts, goal_reached: ev.state.goalReached, last_trigger };
        }
        // ponytail: created_at 은 서버 시각이다(record_turn 은 void, DB 값과 ms 차). 기록 뒤 다시 읽다 실패하면 재전송 중복이 생겨 읽지 않는다.
        yield ev.ended ? { type: 'done', ended: true, report } : { type: 'done', ended: false, turns: turns.map(t => ({ ...t, created_at: at })) };
      }
    }
  } catch (err) {
    o.log.error({ err }, 'turn failed');
    yield { type: 'error', code: 'provider_unavailable', message: (err as Error)?.name === 'TimeoutError' ? 'turn timed out' : 'turn failed', retryable: true };
  } finally {
    if (!recorded) await release();
  }
}
