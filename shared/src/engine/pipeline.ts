// 턴 파이프라인 스케치: 규칙 엔진 + 어댑터를 묶어 한 턴을 만든다. 서버(2·3단계)와 1단계 클라이언트 목이 같은 함수를 쓴다.
// 이벤트 이름은 C7 의 SSE 이벤트와 같다(classification·student·mentor·trigger·done). 실제 SSE 직렬화·DB 기록은 여기 없다.
import { collect, type Criteria, type Lang, type Message, type Provider } from './adapter.ts';
import { parseClassification, type Classification } from './classification.ts';
import { TRIGGER, type Trigger } from '../leverage.ts';
import { HELP_LINE, judgeTurn, reportInput, runtimeBlock, type SessionState, type StudentLines } from './engine.ts';

export interface Compiled { student: string; analysis: string | null; mentor: string }
export interface Turn { speaker: 'teacher' | 'student' | 'mentor'; text: string }
export interface Translation extends StudentLines { greet: string; chars: string; elicit: string[]; t1: string; t2: string; t3: string }
export interface Bots { student: Provider; analysis: Provider; mentor: Provider; model: string }

export type TurnEvent =
  | { type: 'classification'; cls: Classification | null }
  | { type: 'student'; text: string }
  | { type: 'trigger'; trigger: Trigger }
  | { type: 'mentor'; text: string }
  | { type: 'done'; state: SessionState; ended: boolean; summary?: string };

const L = { ko: { student: '학생', teacher: '예비교사', trig: (n: number) => `[TRIGGER] 트리거 ${n} — ${['', '주도권 빼앗기', '도움 요청', '도달점 도달'][n]}` },
  en: { student: 'Student', teacher: 'Teacher', trig: (n: number) => `[TRIGGER] Trigger ${n} — ${['', 'Taking Over', 'Help request', 'Goal reached'][n]}` } };

/** 학생 호출의 messages: 멘토 발화는 예비교사에게 한 말이므로 학생 이력에서 제외한다. */
export function studentMessages(history: Turn[], text: string): Message[] {
  return [...history.filter(t => t.speaker !== 'mentor').map(t => ({ role: t.speaker === 'teacher' ? 'user' as const : 'assistant' as const, content: t.text })), { role: 'user', content: text }];
}
export function analysisTurnMessage(lang: Lang, lastStudent: string, text: string): Message[] {
  return [{ role: 'user', content: `[TURN]\n${L[lang].student}: ${lastStudent}\n${L[lang].teacher}: ${text}` }];
}
export function mentorMessage(lang: Lang, trigger: Trigger, history: Turn[], text: string): Message[] {
  const recent = [...history.filter(t => t.speaker !== 'mentor'), { speaker: 'teacher' as const, text }].slice(-6);
  return [{ role: 'user', content: `${L[lang].trig(trigger)}\n${recent.map(t => `${t.speaker === 'teacher' ? L[lang].teacher : L[lang].student}: ${t.text}`).join('\n')}` }];
}

export async function* runTurn(p: { bots: Bots; compiled: Compiled; criteria: Criteria | null; tr: Translation; lang: Lang; state: SessionState; history: Turn[]; text: string }): AsyncGenerator<TurnEvent> {
  const { bots, compiled, criteria, tr, lang, history, text } = p;
  const lastStudent = [...history].reverse().find(t => t.speaker === 'student')?.text ?? '';
  // 1) 분석: 기준이 없으면 호출 없음. 파싱 실패 시 1회 재요청, 그래도 실패면 Other(PRD 8절). 재요청은 어댑터가 아니라 여기.
  let cls: Classification | null = null;
  if (criteria && compiled.analysis) {
    const req = { system: compiled.analysis, messages: analysisTurnMessage(lang, lastStudent, text), model: bots.model, context: { role: 'analysis' as const, lang, purpose: 'turn' as const, teacherText: text, criteria } };
    for (let i = 0; i < 2 && !cls; i++) cls = parseClassification((await collect(bots.analysis.complete(req))).text, criteria);
    cls ??= { leverage: 'Other', object: criteria.object.length ? 'Other' : null };
  }
  const j = judgeTurn(text, lang, cls, tr, p.state);
  if (j.kind === 'end') {
    let summary: string | undefined;
    if (criteria && compiled.analysis) {
      const report = reportInput(criteria.leverage.map(r => r.name), p.state.counts, p.state.goalReached);
      summary = (await collect(bots.analysis.complete({ system: compiled.analysis, messages: [{ role: 'user', content: `[REPORT]\n${JSON.stringify(report)}` }], model: bots.model, context: { role: 'analysis', lang, purpose: 'report', report } }))).text;
    }
    yield { type: 'done', state: p.state, ended: true, summary }; return;
  }
  yield { type: 'classification', cls };
  // 2) 학생: 도움 요청이면 LLM 을 부르지 않고 고정 문구.
  if (j.kind === 'help') yield { type: 'student', text: HELP_LINE[lang] };
  else {
    const req = { system: compiled.student + runtimeBlock(j.state, j.directive, lang), messages: studentMessages(history, text), model: bots.model,
      context: { role: 'student' as const, lang, teacherText: text, leverage: cls?.leverage ?? null, directive: j.directive, goalReached: p.state.goalReached, lines: { greet: tr.greet, chars: tr.chars, elicit: tr.elicit } } };
    yield { type: 'student', text: (await collect(bots.student.complete(req))).text };
  }
  // 3) 멘토: 트리거 3종 모두 호출(티켓 16).
  const trigger = j.kind === 'help' ? TRIGGER.help : j.trigger;
  if (trigger) {
    yield { type: 'trigger', trigger };
    const req = { system: compiled.mentor, messages: mentorMessage(lang, trigger, history, text), model: bots.model, context: { role: 'mentor' as const, lang, trigger, lines: { t1: tr.t1, t2: tr.t2, t3: tr.t3 } } };
    yield { type: 'mentor', text: (await collect(bots.mentor.complete(req))).text };
  }
  yield { type: 'done', state: j.state, ended: false };
}
