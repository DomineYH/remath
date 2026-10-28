// 연습 세션 (D-15·D-16·G-34): 학생 선택·시작·턴·종료·기록·CSV. 세션 경로는 이 인스턴스의 실(realm) 로그인으로 행동한다.
// 턴은 공유 runTurn + mockProvider 를 그대로 돌린다(#24).
import * as S from '@remath/shared';
import { END_SESSION_RE, mockProvider, runTurn, sessionReport, type SessionState } from '@remath/shared/engine';
import type { z } from 'zod';
import type { AdminSseEvent, Api } from '../types.ts';
import { fail, type Ctx } from './context.ts';
import type { Projection } from './projection.ts';
import type { SessionRow, TurnRow, UserRow } from './store.ts';

export function sessions(c: Ctx, p: Projection) {
  const { db, o, now, uuid, save, who, turnLimit } = c;
  const { groupsOf, tr, compile, scenario, turnsOf, teacherCount, sessionRow, detail } = p;
  /** 남의 세션은 있는지도 알리지 않는다(404). */
  const sessionOf = (id: string) => { const u = who(o.realm); return db.sessions.find(s => s.id === id && s.user_id === u.id) ?? fail('not_found'); };
  const current = (u: UserRow) => db.sessions.find(s => s.user_id === u.id && !s.ended_at);
  const addTurn = (s: SessionRow, t: Pick<TurnRow, 'speaker' | 'text'> & Partial<Pick<TurnRow, 'leverage' | 'object' | 'trigger'>>) => {
    const row: TurnRow = { session_id: s.id, seq: turnsOf(s.id).length + 1, speaker: t.speaker, text: t.text,
      leverage: t.leverage ?? null, object: t.object ?? null, trigger: t.trigger ?? null, created_at: now() };
    db.turns.push(row); const { session_id: _, ...out } = row; return out;
  };
  const start = (scenario_id: string) => {
    const u = who(o.realm), sc = scenario(scenario_id);
    const visible = u.role === 'admin' || (sc.status === 'published' && db.groups.some(g => g.member_ids.includes(u.id) && g.scenario_ids.includes(sc.id)));
    if (!visible) fail('forbidden');   // 초안·미할당은 예비교사에게 403, 관리자는 초안도 대화 테스트(G-34)
    const active = current(u);
    if (active) fail('session_active', 'a session is in progress', { session_id: active.id });
    const t = now(), s: SessionRow = { id: uuid(), user_id: u.id, scenario_id, lang: sc.lang, started_at: t, ended_at: null, goal_reached: false, counts: {},
      progress: { mis: sc.internal.misconceptions.map(() => 0) }, report: null, turn_started_at: null, created_at: t, updated_at: t };
    db.sessions.push(s); addTurn(s, { speaker: 'student', text: tr(sc).greet }); save();
    return detail(s);
  };

  const lastTrigger = (s: SessionRow) => [...turnsOf(s.id)].reverse().find(t => t.trigger)?.trigger ?? null;
  const adminState = (s: SessionRow): z.infer<typeof S.AdminState> => ({ mis: s.progress.mis, counts: s.counts, goal_reached: s.goal_reached, last_trigger: lastTrigger(s) });
  const ownedByAdmin = (s: SessionRow) => db.users.find(u => u.id === s.user_id)?.role === 'admin';
  const bots = { student: mockProvider, analysis: mockProvider, mentor: mockProvider, model: 'mock' };

  /** 한 턴(G-36): runTurn 이벤트 → SSE 이벤트. 이 턴 발화는 done 에서 한꺼번에 seq 를 매겨 기록하고, error 면 하나도 기록하지 않는다.
   *  async generator 라 시작 전 오류(409·422)는 첫 next() 에서 throw 된다. */
  async function* turn(s: SessionRow, text: string): AsyncGenerator<AdminSseEvent> {
    if (s.ended_at) fail('session_ended');
    if (s.turn_started_at) fail('turn_in_progress', 'turn in progress', { turn_started_at: s.turn_started_at });
    const history = turnsOf(s.id), turn_count = teacherCount(history);
    if (!END_SESSION_RE.test(text.trim()) && turn_count >= turnLimit) fail('turn_limit_reached', 'turn limit reached', { turn_count, turn_limit: turnLimit });   // END SESSION 은 상한 앞(D-15)
    const sc = scenario(s.scenario_id), t = sc.translations[s.lang], criteria = sc.classification.leverage.length ? sc.classification : null;
    const state: SessionState = { mis: s.progress.mis, counts: s.counts, goalReached: s.goal_reached, takeOverCount: history.filter(h => h.trigger === S.TRIGGER.takingOver).length };
    const pending: Parameters<typeof addTurn>[1][] = [{ speaker: 'teacher', text }];
    s.turn_started_at = now(); save();
    // ponytail: TURN_TIMEOUT_MS 는 흉내 내지 않는다(D-15). finally 가 항상 지우고, 새로고침으로 남은 고아 플래그는 Store 로드가 지운다.
    try {
      for await (const ev of runTurn({ bots, compiled: sc.compiled_prompt ?? compile(sc), criteria, tr: t, lang: s.lang, state, history, text })) {
        if (ev.type === 'classification') { if (ev.cls) { Object.assign(pending[0], ev.cls); yield { type: 'classification', ...ev.cls }; } }
        else if (ev.type === 'student') { pending.push({ speaker: 'student', text: ev.text }); yield { type: 'student', text: ev.text, final: true }; }
        else if (ev.type === 'trigger') { pending.push({ speaker: 'mentor', text: '', trigger: ev.trigger }); yield ev; }
        else if (ev.type === 'mentor') { pending[pending.length - 1].text = ev.text; yield { type: 'mentor', text: ev.text, final: true }; }
        else {
          const at = now();
          s.updated_at = at;
          if (ev.ended) { s.ended_at = at; s.report = sessionReport(sc.classification.leverage, history, s.goal_reached, ev.summary ?? null); }
          else { s.progress = { mis: ev.state.mis }; s.counts = ev.state.counts; s.goal_reached = ev.state.goalReached; }
          const turns = ev.ended ? [] : pending.map(x => addTurn(s, x));
          if (ownedByAdmin(s)) yield { type: 'state', ...adminState(s) };   // 관리자 세션만, done 직전 1회(D-16)
          yield ev.ended ? { type: 'done', ended: true, report: s.report } : { type: 'done', ended: false, turns };
        }
      }
    } catch (e) {
      yield { type: 'error', code: 'provider_unavailable', message: String((e as Error).message), retryable: true };
    } finally { s.turn_started_at = null; save(); }
  }
  /** 종료 버튼 = END SESSION 발화(G-34): 같은 리포트를 한 번 저장. 두 번째는 409 session_ended, 재열람은 getSession 의 저장본. */
  const end = async (s: SessionRow) => {
    for await (const ev of turn(s, 'END SESSION')) {
      if (ev.type === 'error') fail('provider_unavailable', ev.message);
      if (ev.type === 'done' && ev.ended) return ev.report;
    }
    return null;
  };

  const filtered = (q: z.infer<typeof S.SessionFilter>) => db.sessions
    .filter(s => (!q.user_id || s.user_id === q.user_id) && (!q.scenario_id || s.scenario_id === q.scenario_id))
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
  /** C13: 1행 = 1발화, 모든 칸을 따옴표로. 앞의 BOM 은 엑셀이 UTF-8 로 열게 한다(Blob 바이트에 남는다). */
  const csv = (rows: SessionRow[]) => {
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const body = rows.flatMap(s => {
      const r = sessionRow(s);
      return turnsOf(s.id).map(t => [s.id, s.started_at, r.nickname, r.scenario_name, s.lang, t.seq, t.speaker, t.text, t.leverage, t.object, t.trigger].map(q).join(','));
    });
    return '﻿' + ['session_id,started_at,nickname,scenario,lang,seq,speaker,text,leverage,object,trigger', ...body].join('\r\n');
  };

  return {
    getPractice: async () => {
      const u = who('teacher'), mine = db.groups.filter(g => g.member_ids.includes(u.id));
      const scenarios = db.scenarios.filter(s => s.status === 'published' && mine.some(g => g.scenario_ids.includes(s.id)));
      return { groups: groupsOf(g => mine.includes(g)), scenarios: scenarios.map(s => ({ ...S.scenarioPublic(s), group_ids: mine.filter(g => g.scenario_ids.includes(s.id)).map(g => g.id) })) };
    },
    listSessions: async () => { const u = who('teacher'); return filtered({ user_id: u.id }).map(sessionRow); },
    getCurrentSession: async () => { const s = current(who(o.realm)); return s ? detail(s) : null; },
    startSession: async b => start(b.scenario_id), getSession: async id => detail(sessionOf(id)),
    // 관리자 세션의 `state` 는 AdminApi 타입으로만 보인다(createApi('admin') 이 좁힌다).
    sendTurn: async function* (id: string, b: z.infer<typeof S.TurnBody>) {
      // E2E 전용 1회성 끊김(I-51): 'before' = 첫 이벤트에서(기록 없음), 'after' = done 에서(이미 기록됨). 목에는 네트워크가 없어 route-abort 가 닿지 않는다.
      const g = globalThis as { __remathMockDrop?: 'before' | 'after' }, drop = g.__remathMockDrop; delete g.__remathMockDrop;
      for await (const ev of turn(sessionOf(id), b.text)) {
        if (drop === 'before' || (drop === 'after' && ev.type === 'done')) throw new TypeError('network error (mock drop)');
        yield ev;
      }
    } as Api['sendTurn'],
    endSession: async id => end(sessionOf(id)),

    listAdminSessions: async q => filtered(q).map(sessionRow),
    getAdminSession: async id => { const s = db.sessions.find(x => x.id === id) ?? fail('not_found'); return { ...detail(s), state: adminState(s) }; },
    downloadSessionsCsv: async q => new Blob([csv(filtered(q))], { type: 'text/csv;charset=utf-8' }),
  } satisfies Partial<Api>;
}
