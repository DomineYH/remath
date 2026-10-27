// MOCK_LLM 어댑터: Provider 인터페이스를 만족하되 LLM 대신 context 와 목업 대사 규칙으로 답한다.
// 판정(카운터·트리거·도움 요청)은 하지 않는다 — 그건 engine.ts(서버). 여기는 "지시를 받아 대사를 고르는" 역할만.
import { AdapterError, type CompleteRequest, type Lang, type MockContext, type Provider, type ReportInput, type StreamEvent } from '../adapter.ts';
import { renderClassification } from '../classification.ts';
import { isGreeting, mockClassify, stdLeverage } from './classify.ts';

/** 목업 TXT 의 챗봇 대사(화면 문구는 제외). */
export const TXT = {
  ko: { help: '음… 저 아직 생각 중이에요.', helpLead: '이런 질문으로 시작해 보세요:', idk: '네? 음… 잘 모르겠어요.',
    reached: ['네! 이제 알겠어요. 제 답 바꿀래요.', '맞아요, 아까 제가 한 말대로예요. 다른 친구들한테도 설명해 줄 수 있어요.'],
    dist: (n: string[], c: Record<string, number>) => `이번 세션의 발문 분포는 ${n.map(x => `${x} ${c[x] ?? 0}회`).join(', ')}입니다. 각 분류의 설명과 비교하며 발문 흐름을 돌아보세요.`,
    none: '아직 발문이 거의 없었어요. 다음 세션에서는 학생의 그림과 풀이에 대해 먼저 물어보는 것으로 시작해 보세요.',
    clean: (e: number, x: number) => `세션 내내 학생의 생각을 끌어내는 질문(Eliciting ${e}회)과 확장하는 질문(Extending ${x}회)으로만 진행했어요. 학생이 자기 전략 위에서 생각을 바꿀 수 있는 좋은 흐름이었습니다.`,
    heavy: (b: number, g: number) => `방법을 직접 제시하는 발화(Taking Over ${b}회)가 끌어내기·확장 질문(${g}회)보다 많았어요. 학생이 혼란스러워한 순간을 돌아보고, 그 자리에 "어떻게 생각했어?"류 질문을 넣어 보세요.`,
    mixed: (g: number, b: number) => `끌어내기·확장 질문 ${g}회, 주도권을 가져간 발화 ${b}회였어요. 대체로 학생 중심이었고, Taking Over 지점만 질문으로 바꾸면 더 좋아질 거예요.`,
    endReached: '학생이 스스로 결론을 수정하는 지점까지 도달했습니다.', endNot: '학생은 아직 처음 생각에 머물러 있어요. 학생의 그림과 조각 크기에 대한 질문을 더 이어가 보세요.' },
  en: { help: "Um… I'm still thinking.", helpLead: 'Try starting with questions like these:', idk: "Huh? Um… I don't really know.",
    reached: ["Yeah! I get it now. I'm changing my answer.", 'Right, like I said before. I could explain it to my friends too.'],
    dist: (n: string[], c: Record<string, number>) => `Your questions this session: ${n.map(x => `${x} ×${c[x] ?? 0}`).join(', ')}. Compare them with each category's description and look back at how your questioning flowed.`,
    none: "You asked very few questions this time. Next session, start by asking about the student's drawing and solution.",
    clean: (e: number, x: number) => `You kept the whole session to questions that drew out the student's thinking (Eliciting ×${e}) and extended it (Extending ×${x}). That let the student change their mind from inside their own strategy.`,
    heavy: (b: number, g: number) => `Moves that handed over the method (Taking Over ×${b}) outnumbered eliciting and extending questions (×${g}). Look back at the moments the student got confused and try a "How did you think about it?" question there instead.`,
    mixed: (g: number, b: number) => `You asked ${g} eliciting/extending questions and made ${b} Taking Over moves. The session was mostly student-centered; turning those Taking Over moments into questions would make it stronger.`,
    endReached: 'The student reached the point of revising their own conclusion.', endNot: 'The student is still holding on to their first idea. Keep asking about their drawing and the size of the pieces.' },
} as const;

/** 회전 인덱스는 저장하지 않고 "지금까지 낸 같은 세트의 대사 수"로 유도한다(ADR-0002 Consequences). MOCK 은 대사를 그대로 내므로 정확히 셀 수 있다. */
const rotation = (req: CompleteRequest, set: readonly string[]) => req.messages.filter(m => m.role === 'assistant' && set.includes(m.content)).length;

function studentText(req: CompleteRequest, c: Extract<MockContext, { role: 'student' }>): string {
  const T = TXT[c.lang];
  if (c.directive) return c.directive.text;
  if (c.goalReached) return T.reached[rotation(req, T.reached) % 2];
  if (isGreeting(c.teacherText, c.lang)) {
    const lines = c.lines.chars.split('\n').map(x => x.replace(/^- /, '').trim()).filter(Boolean);
    const like = (lines.find(x => /좋아|like|love/i.test(x)) ?? lines[0] ?? '').replace(/\.$/, '').replace(/좋아함$/, '좋아해요');
    return /이름|학년|안녕|반가|name|grade|\bhi\b|hello|nice to meet/i.test(c.teacherText) ? c.lines.greet.split(/(?<=[.!?…])\s+/).slice(0, 2).join(' ') : (c.lang === 'en' ? `Um… ${like}!` : `음… ${like}!`);
  }
  // 목업: Eliciting/Extending 이면 elicit 회전, 그 외 idk. 분류 기준이 없는 시나리오는 목업처럼 내장 규칙으로 근사한다.
  const lev = c.leverage ?? stdLeverage(c.teacherText, c.lang);
  if (lev === 'Eliciting' || lev === 'Extending') return c.lines.elicit[rotation(req, c.lines.elicit) % c.lines.elicit.length];
  return T.idk;
}

function reportText(lang: Lang, r: ReportInput): string {
  const T = TXT[lang], c = r.counts, good = (c.Eliciting ?? 0) + (c.Extending ?? 0), bad = c['Taking Over'] ?? 0;
  const fb = r.verdict === 'dist' ? T.dist(r.names, c) : r.verdict === 'none' ? T.none : r.verdict === 'clean' ? T.clean(c.Eliciting ?? 0, c.Extending ?? 0) : r.verdict === 'heavy' ? T.heavy(bad, good) : T.mixed(good, bad);
  return `${fb}\n${r.reached ? T.endReached : T.endNot}`;
}

function mentorText(c: Extract<MockContext, { role: 'mentor' }>): string {
  if (c.trigger === 1) return c.lines.t1;
  if (c.trigger === 3) return c.lines.t3;
  return `${TXT[c.lang].helpLead}\n${c.lines.t2.split('\n').filter(Boolean).map(x => '· ' + x).join('\n')}`;
}

export function mockText(req: CompleteRequest): string {
  const c = req.context; if (!c) throw new AdapterError('mock', 'no_context', 'MOCK_LLM requires req.context');
  switch (c.role) {
    case 'student': return studentText(req, c);
    case 'analysis': return c.purpose === 'turn' ? renderClassification(mockClassify(c.teacherText, c.lang, c.criteria)) : reportText(c.lang, c.report);
    case 'mentor': return mentorText(c);
  }
}

export const mockProvider: Provider = {
  id: 'mock',
  async *complete(req): AsyncIterable<StreamEvent> {
    req.signal?.throwIfAborted();
    // ponytail: 델타 하나로 낸다. 타이핑 표시를 시연해야 하면 어절 단위 분할 + 지연 옵션을 여기 추가.
    yield { type: 'delta', text: mockText(req) };
    yield { type: 'done', model: req.model, stopReason: 'end' };
  },
  async listModels() { return ['mock']; },
};
