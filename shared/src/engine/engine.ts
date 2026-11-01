// 서버 규칙 엔진 (ADR-0002, 목업 engineTurn 이식). MOCK·실 LLM 경로가 같은 함수를 쓴다. 어댑터가 아니다.
import type { z } from 'zod';
import type { SessionReport as SessionReportSchema } from '../api/schemas.ts';
import type { ClassificationRow, Lang, ReportInput, TurnDirective } from './adapter.ts';
import type { Classification } from './classification.ts';
import { LEVERAGE, TRIGGER } from '../leverage.ts';

export interface Misconception { kw: string; h: string; c: string }
export interface StudentLines { misconceptions: Misconception[]; confused: string[]; aha: string }
/** sessions.progress.mis · counts · goal_reached + turns 집계(trigger=1 횟수). 회전 인덱스는 저장하지 않는다. */
export interface SessionState { mis: number[]; counts: Record<string, number>; goalReached: boolean; takeOverCount: number }

export const END_SESSION_RE = /^end session$/i;
/** 도움 요청은 시나리오 데이터가 아니라 서버 상수(ADR-0002). 목업 detectStd/detectEn 의 help 패턴. */
export const HELP_RE: Record<Lang, RegExp> = { ko: /도와|힌트|어떻게 물어|어떤 질문|뭐라고 물|질문 추천/, en: /\bhelp\b|\bhint\b|what should i ask|which question|suggest a question/i };
/** 도움 요청 턴의 학생 고정 문구: LLM 을 부르지 않는다(실 LLM·MOCK 공통). */
export const HELP_LINE: Record<Lang, string> = { ko: '음… 저 아직 생각 중이에요.', en: "Um… I'm still thinking." };

/** 목업 kwTest: 정규식으로 해석되지 않으면 부분 문자열. */
export function kwTest(kw: string, m: string): boolean {
  try { return new RegExp(kw, 'i').test(m); } catch { return m.toLowerCase().includes(kw.toLowerCase()); }
}

export type Judgement =
  | { kind: 'end' }
  | { kind: 'help'; state: SessionState }
  | { kind: 'turn'; directive: TurnDirective | null; trigger: typeof TRIGGER.takingOver | typeof TRIGGER.goal | null; state: SessionState };

/** 한 턴의 서버 판정(ADR-0002 순서 1→6). cls 는 분석 챗봇 결과(분류 기준이 없으면 null). 입력 state 를 바꾸지 않는다. */
export function judgeTurn(text: string, lang: Lang, cls: Classification | null, lines: StudentLines, prev: SessionState): Judgement {
  const t = text.trim();
  if (END_SESSION_RE.test(t)) return { kind: 'end' };
  const state: SessionState = { ...prev, mis: [...prev.mis], counts: { ...prev.counts } };
  if (cls) state.counts[cls.leverage] = (state.counts[cls.leverage] ?? 0) + 1;
  if (HELP_RE[lang].test(t)) return { kind: 'help', state };
  if (state.goalReached) return { kind: 'turn', directive: null, trigger: null, state };
  if (cls?.leverage === LEVERAGE.takingOver) {
    const n = state.takeOverCount++;
    return { kind: 'turn', directive: { kind: 'confused', text: lines.confused[n % lines.confused.length] }, trigger: TRIGGER.takingOver, state };
  }
  const idx = lines.misconceptions.findIndex((mi, i) => state.mis[i] < 2 && mi.kw && kwTest(mi.kw, t));
  if (idx < 0) return { kind: 'turn', directive: null, trigger: null, state };
  const n = ++state.mis[idx], mi = lines.misconceptions[idx];
  if (n === 1) return { kind: 'turn', directive: { kind: 'hesitation', text: mi.h }, trigger: null, state };
  // 아하 턴 지시는 aha 한 줄(#68): c 를 겹쳐 넣으면 학생이 두 문장을 나눠 잇는다. aha 가 비면 마지막 c 가 대신한다.
  if (state.mis.every(x => x >= 2)) { state.goalReached = true; return { kind: 'turn', directive: { kind: 'aha', text: lines.aha.trim() ? lines.aha : mi.c }, trigger: TRIGGER.goal, state }; }
  return { kind: 'turn', directive: { kind: 'correction', text: mi.c }, trigger: null, state };
}

/** 끌어내기·확장 발문(good)과 Taking Over(bad) 횟수. 판정과 MOCK 리포트 문장이 같은 셈을 쓴다. */
export const tally = (c: Record<string, number>) => ({ good: (c[LEVERAGE.eliciting] ?? 0) + (c[LEVERAGE.extending] ?? 0), bad: c[LEVERAGE.takingOver] ?? 0 });

/** 세션 종료 판정(목업 engineEnd). 리포트 전체 스키마는 티켓 14. 여기서는 분석 챗봇 입력에 필요한 부분만. */
export function reportInput(names: string[], counts: Record<string, number>, reached: boolean): ReportInput {
  const { good, bad } = tally(counts);
  const std = names.some(n => (Object.values(LEVERAGE) as string[]).includes(n));
  const verdict = !std ? 'dist' : good === 0 && bad === 0 ? 'none' : bad === 0 ? 'clean' : bad > good ? 'heavy' : 'mixed';
  return { names, counts, verdict, reached };
}

const RUNTIME = {
  ko: { head: 'H) 이번 턴 (서버 주입)', mis: '오개념 진행', prog: ['미교정(0/2)', '망설임(1/2)', '교정됨'], goal: (r: boolean) => `도달점: ${r ? '도달' : '미도달'}`,
    dir: (t: string) => `이번 턴 지시: 반드시 다음 취지로, 네 말투로 답하십시오 — "${t}"`, none: '이번 턴 지시: 없음. 현재 오개념 상태를 유지하고 질문받은 것만 답하십시오.' },
  en: { head: 'H) This turn (server-injected)', mis: 'Misconceptions', prog: ['uncorrected (0/2)', 'hesitating (1/2)', 'corrected'], goal: (r: boolean) => `Goal: ${r ? 'reached' : 'not reached'}`,
    dir: (t: string) => `This turn: you must answer with exactly this gist, in your own voice — "${t}"`, none: 'This turn: none. Keep your current misconceptions and answer only what was asked.' },
};

/** ADR-0002 런타임 블록. 학생 system 뒤에 호출마다 덧붙인다. */
export function runtimeBlock(state: SessionState, directive: TurnDirective | null, lang: Lang): string {
  const L = RUNTIME[lang], bar = '========================================================';
  const prog = state.mis.map((n, i) => `${i + 1}) ${L.prog[n >= 2 ? 2 : n === 1 ? 1 : 0]}`).join('  ');
  return `\n${bar}\n${L.head}\n${bar}\n${L.mis}: ${prog}\n${L.goal(state.goalReached)}\n${directive ? L.dir(directive.text) : L.none}\n`;
}

/** 종료 리포트(D-17, 티켓 14): 분류 기준 순서의 rows(설명·발화 스냅샷) + total + 판정. 레버리지 기준이 없으면 null. summary 는 분석 챗봇 문장(실패 시 null). */
export function sessionReport(leverage: ClassificationRow[], turns: { seq: number; speaker: string; text: string; leverage: string | null }[], reached: boolean, summary: string | null): z.infer<typeof SessionReportSchema> | null {
  if (!leverage.length) return null;
  const rows = leverage.map(r => { const ts = turns.filter(t => t.speaker === 'teacher' && t.leverage === r.name).map(t => ({ seq: t.seq, text: t.text })); return { name: r.name, desc: r.desc ?? '', count: ts.length, turns: ts }; });
  const { verdict } = reportInput(rows.map(r => r.name), Object.fromEntries(rows.map(r => [r.name, r.count])), reached);
  return { total: rows.reduce((n, r) => n + r.count, 0), reached, verdict, rows, summary };
}
