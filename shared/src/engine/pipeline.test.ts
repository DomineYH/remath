// C-3 (broken analysis adapter → one retry → Other; MOCK without context → no_context; aborted signal → throw)
// and the mockup L1·L2 replays through runTurn (the base of A-3; sendTurn replays land in #24).
import gabriel from '@remath/seed/scenarios/gabriel.json';
import { describe, expect, it } from 'vitest';
import { AdapterError, collect, judgeTurn, mockProvider, runTurn, TXT, type Criteria, type Provider, type SessionState, type Turn, type TurnEvent } from './index.ts';

const criteria: Criteria = gabriel.classification;
const bots = { student: mockProvider, analysis: mockProvider, mentor: mockProvider, model: 'mock' };
const compiled = { student: '<student system>', analysis: '<analysis system>', mentor: '<mentor system>' }; // MOCK never reads these
const fresh = (n = 3): SessionState => ({ mis: Array(n).fill(0), counts: {}, goalReached: false, takeOverCount: 0 });
const events = async (it: AsyncIterable<TurnEvent>) => { const out: TurnEvent[] = []; for await (const e of it) out.push(e); return out; };

async function replay(lang: 'ko' | 'en', qs: string[], crit: Criteria | null) {
  const tr = gabriel.translations[lang];
  let state = fresh(), summary: string | undefined;
  const history: Turn[] = [{ speaker: 'student', text: tr.greet }], log: TurnEvent[][] = [];
  for (const q of qs) {
    const evs = await events(runTurn({ bots, compiled, criteria: crit, tr, lang, state, history, text: q }));
    log.push(evs); history.push({ speaker: 'teacher', text: q });
    for (const ev of evs) {
      if (ev.type === 'student' || ev.type === 'mentor') history.push({ speaker: ev.type, text: ev.text });
      if (ev.type === 'done') { state = ev.state; summary = ev.summary; }
    }
  }
  return { log, state, summary, history };
}
const pick = <K extends TurnEvent['type']>(evs: TurnEvent[], type: K) => evs.find(e => e.type === type) as Extract<TurnEvent, { type: K }> | undefined;
const student = (evs: TurnEvent[]) => pick(evs, 'student')?.text;
const mentor = (evs: TurnEvent[]) => pick(evs, 'mentor')?.text;
const trigger = (evs: TurnEvent[]) => pick(evs, 'trigger')?.trigger;
const leverage = (evs: TurnEvent[]) => pick(evs, 'classification')?.cls?.leverage;

describe('C-3 adapter failures', () => {
  it('unparseable analysis output is re-requested once, then recorded as Other', async () => {
    let calls = 0;
    const broken: Provider = { ...mockProvider, async *complete() { calls++; yield { type: 'delta', text: 'garbage' }; yield { type: 'done', model: 'x', stopReason: 'end' }; } };
    const evs = await events(runTurn({ bots: { ...bots, analysis: broken }, compiled, criteria, tr: gabriel.translations.ko, lang: 'ko', state: fresh(), history: [], text: '왜 그렇게 생각했어?' }));
    expect(calls).toBe(2);
    expect(pick(evs, 'classification')?.cls).toEqual({ leverage: 'Other', object: 'Other' });
    expect(pick(evs, 'done')?.state.counts).toEqual({ Other: 1 });
  });
  it('MOCK without context throws AdapterError no_context', async () => {
    await expect(collect(mockProvider.complete({ system: '', messages: [], model: 'mock' }))).rejects.toSatisfy(e => e instanceof AdapterError && e.code === 'no_context');
  });
  it('an aborted signal throws', async () => {
    const ac = new AbortController(); ac.abort();
    const context = { role: 'mentor' as const, lang: 'ko' as const, trigger: 1 as const, lines: { t1: 'a', t2: 'b', t3: 'c' } };
    await expect(collect(mockProvider.complete({ system: '', messages: [], model: 'mock', context, signal: ac.signal }))).rejects.toThrow();
  });
});

describe('mockup replays through runTurn', () => {
  it('L1 · Gabriel reaches the goal (ko)', async () => {
    const ko = gabriel.translations.ko, m = ko.misconceptions;
    const r = await replay('ko', ['안녕, 네 이름이 뭐야?', '어떻게 풀었는지 말해 줄래?', '한 친구가 받는 걸 모두 합치면 얼마야?', '그러면 한 사람이 받는 게 전부 얼마인지 하나로 말해 볼래?', '4분의 1 조각을 반으로 자르면 어떻게 될까?', '그 조각을 더 작게 자르면 8분의 1이 몇 개야?', '8분의 1 조각이 다 해서 몇 개야?', '모두 몇 조각인지 세어 볼래?', 'END SESSION'], criteria);
    expect(r.log.slice(0, 8).map(student)).toEqual(['안녕하세요… 저는 가브리엘이에요.', ko.elicit[0], m[0].h, m[0].c, m[1].h, m[1].c, m[2].h, `${m[2].c}\n${ko.aha}`]);
    expect(r.log.slice(0, 8).map(trigger)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined, 3]);
    expect(mentor(r.log[7])).toBe(ko.t3);
    expect(r.log.slice(0, 8).map(leverage)).toEqual(['Other', 'Eliciting', 'Eliciting', 'Eliciting', 'Extending', 'Extending', 'Eliciting', 'Eliciting']);
    expect(r.state).toEqual({ mis: [2, 2, 2], counts: { Other: 1, Eliciting: 5, Extending: 2 }, goalReached: true, takeOverCount: 0 });
    expect(r.summary).toBe(`${TXT.ko.clean(5, 2)}\n${TXT.ko.endReached}`);
    expect(r.history.some(t => /^(Mentor|멘토|Student|학생):/.test(t.text))).toBe(false);
  });
  it('L2 · Taking Over twice (ko)', async () => {
    const ko = gabriel.translations.ko;
    const r = await replay('ko', ['안녕!', '통분하면 돼. 분모를 같게 만들어 봐.', '2/4는 4/8이니까 더하면 5/8이야. 답은 5/8이야.', '그림을 어떻게 그렸어?', 'END SESSION'], criteria);
    expect(r.log.slice(1, 4).map(student)).toEqual([ko.confused[0], ko.confused[1], ko.elicit[0]]);
    expect(r.log.slice(1, 4).map(trigger)).toEqual([1, 1, undefined]);
    expect(mentor(r.log[1])).toBe(ko.t1);
    expect(r.summary).toBe(`${TXT.ko.heavy(2, 1)}\n${TXT.ko.endNot}`);
  });
  it('help request (en, no criteria): fixed line, trigger 2, helpLead frames, no analysis', async () => {
    const en = gabriel.translations.en;
    const r = await replay('en', ['Help', 'Can you tell me how you solved it?'], null);
    expect(student(r.log[0])).toBe("Um… I'm still thinking.");
    expect(trigger(r.log[0])).toBe(2);
    expect(mentor(r.log[0])).toBe(`Try starting with questions like these:\n${en.t2.split('\n').map(x => '· ' + x).join('\n')}`);
    expect(leverage(r.log[0])).toBeUndefined();
    expect(student(r.log[1])).toBe(en.elicit[0]);
    expect(r.state.counts).toEqual({});
  });
  it('after the goal: no directive or trigger, only the leverage count rises', () => {
    const st: SessionState = { mis: [2, 2, 2], counts: {}, goalReached: true, takeOverCount: 0 };
    expect(judgeTurn('Just add them, the answer is 5/8.', 'en', { leverage: 'Taking Over', object: null }, gabriel.translations.en, st))
      .toEqual({ kind: 'turn', directive: null, trigger: null, state: { ...st, counts: { 'Taking Over': 1 } } });
  });
});
