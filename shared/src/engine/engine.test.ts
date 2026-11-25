// #68: 아하 턴(마지막 오개념 2회차로 모두 교정) 지시는 aha 한 줄. aha 가 비면 마지막 c 로 대신한다. 남은 오개념이 있으면 교정 지시 그대로.
import gabriel from '@remath/seed/scenarios/gabriel.json';
import hajun from '@remath/seed/scenarios/hajun.json';
import jiwoo from '@remath/seed/scenarios/jiwoo.json';
import noah from '@remath/seed/scenarios/noah.json';
import seoyeon from '@remath/seed/scenarios/seoyeon.json';
import { describe, expect, it } from 'vitest';
import { isGreetingOnly, judgeTurn, mockProvider, mockText, runtimeBlock, runTurn, type Bots, type Lang, type SessionState, type Translation } from './index.ts';

const st = (mis: number[]): SessionState => ({ mis, counts: {}, goalReached: false, takeOverCount: 0 });
/** 마지막 오개념(m[2])만 1회차인 상태에서 그 키워드가 맞는 발화. */
const lastQ = { ko: '모두 몇 조각인지 세어 볼래?', en: 'Can you count the pieces?' } as const;

describe('judgeTurn aha directive (#68)', () => {
  for (const lang of ['ko', 'en'] as const) {
    it(`${lang}: the goal turn directive is the aha line alone, trigger 3, goalReached`, () => {
      const tr = gabriel.translations[lang];
      const j = judgeTurn(lastQ[lang], lang, null, tr, st([2, 2, 1]));
      expect(j).toEqual({ kind: 'turn', directive: { kind: 'aha', text: tr.aha }, trigger: 3, state: { ...st([2, 2, 2]), goalReached: true } });
    });
  }
  it('empty or whitespace aha falls back to the last corrected misconception c', () => {
    const tr = gabriel.translations.ko;
    for (const aha of ['', '  \n ']) {
      const j = judgeTurn(lastQ.ko, 'ko', null, { ...tr, aha }, st([2, 2, 1]));
      expect(j.kind === 'turn' && j.directive).toEqual({ kind: 'aha', text: tr.misconceptions[2].c });
      expect(j.kind === 'turn' && j.trigger).toBe(3);
    }
  });
  it('a second correction with misconceptions left is still the plain correction, no trigger', () => {
    const tr = gabriel.translations.ko;
    const j = judgeTurn('한 사람이 받는 게 전부 얼마야?', 'ko', null, tr, st([1, 0, 0]));
    expect(j).toEqual({ kind: 'turn', directive: { kind: 'correction', text: tr.misconceptions[0].c }, trigger: null, state: st([2, 0, 0]) });
  });
  it('runtimeBlock on the goal turn quotes the aha line on one line, with no newline inside the quotes', () => {
    for (const lang of ['ko', 'en'] as const) {
      const tr = gabriel.translations[lang];
      const j = judgeTurn(lastQ[lang], lang, null, tr, st([2, 2, 1]));
      if (j.kind !== 'turn') throw new Error('expected a turn');
      const block = runtimeBlock(j.state, j.directive, lang);
      expect(block).not.toMatch(/"[^"]*\n[^"]*"/);
      expect(block.split('\n').some(l => l.endsWith(`"${tr.aha}"`))).toBe(true);
    }
  });
});

// #100: 인사만 있는 턴(교정 키워드 없음)은 greet 지시. 런타임 블록이 "인사·자기소개만, 답·풀이·결론 금지" 고정 문구를 렌더링한다.
describe('judgeTurn greet directive (#100)', () => {
  const greet = { kind: 'greet', text: '' } as const;
  const hi = { ko: '안녕!', en: 'Hi!' } as const;
  const fresh = (): SessionState => ({ mis: [0, 0, 0], counts: { Other: 2 }, goalReached: false, takeOverCount: 1 });
  for (const lang of ['ko', 'en'] as const) {
    it(`${lang}: a greeting-only turn gets the greet directive, no trigger, state unchanged`, () => {
      const j = judgeTurn(hi[lang], lang, null, gabriel.translations[lang], fresh());
      expect(j).toEqual({ kind: 'turn', directive: greet, trigger: null, state: fresh() });
    });
  }
  it('counts still go up by the classification on a greet turn', () => {
    const j = judgeTurn('안녕!', 'ko', { leverage: 'Other', object: 'Other' }, gabriel.translations.ko, fresh());
    expect(j).toEqual({ kind: 'turn', directive: greet, trigger: null, state: { ...fresh(), counts: { Other: 3 } } });
  });
  it('greeting + a misconception keyword: the keyword directive wins (hesitation)', () => {
    const tr = hajun.translations.ko;
    const j = judgeTurn('안녕! 피자를 몇 조각으로 나눴어?', 'ko', null, tr, fresh());
    expect(j.kind === 'turn' && j.directive).toEqual({ kind: 'hesitation', text: tr.misconceptions[0].h });
  });
  it('greeting + problem vocabulary without a keyword: no directive (as before)', () => {
    expect(isGreetingOnly('안녕, 피자 문제 어떻게 풀었어?', 'ko', '가브리엘')).toBe(false);
    const j = judgeTurn('안녕, 피자 문제 어떻게 풀었어?', 'ko', null, gabriel.translations.ko, fresh());
    expect(j.kind === 'turn' && j.directive).toBeNull();
    expect(isGreetingOnly('Hi! How did you solve the pizza problem?', 'en', 'Gabriel')).toBe(false);
  });
  it('greeting + another question with no keyword or problem word: no directive', () => {
    for (const [text, lang] of [['안녕! 누가 더 많이 먹었어?', 'ko'], ['Hi! Who ate more?', 'en']] as const) {
      const tr = hajun.translations[lang], st0: SessionState = { mis: tr.misconceptions.map(() => 0), counts: {}, goalReached: false, takeOverCount: 0 };
      expect(isGreetingOnly(text, lang, tr.name)).toBe(false);
      expect(judgeTurn(text, lang, null, tr, st0)).toEqual({ kind: 'turn', directive: null, trigger: null, state: st0 });
    }
  });
  it('every clause is greeting or small talk: greeting-only', () => {
    expect(isGreetingOnly('안녕, 이름이 뭐야?', 'ko', '하준')).toBe(true);
    expect(isGreetingOnly("Hi, what's your name?", 'en', 'Hajun')).toBe(true);
    expect(isGreetingOnly(' ! , ', 'ko', '하준')).toBe(false);
  });
  it('a teacher self-introduction stays greeting-only; broad words do not', () => {
    expect(isGreetingOnly('안녕하세요, 선생님이에요.', 'ko', '하준')).toBe(true);
    expect(judgeTurn('안녕하세요, 선생님이에요.', 'ko', null, hajun.translations.ko, fresh())).toEqual({ kind: 'turn', directive: greet, trigger: null, state: fresh() });
    expect(isGreetingOnly('Hello Noah, I am your teacher.', 'en', 'Noah')).toBe(true);
    expect(isGreetingOnly('안녕! 나는 선생님이야, 누가 더 많이 먹었어?', 'ko', '하준')).toBe(false);
    expect(isGreetingOnly("Hi, I'm curious who ate more", 'en', 'Hajun')).toBe(false);
  });
  it('after the goal is reached a greeting gets no directive', () => {
    const done = { ...fresh(), mis: [2, 2, 2], goalReached: true };
    const j = judgeTurn('안녕!', 'ko', null, gabriel.translations.ko, done);
    expect(j).toEqual({ kind: 'turn', directive: null, trigger: null, state: done });
  });
  it('runtimeBlock renders the fixed greet line, not the none line or an empty quote', () => {
    const ko = runtimeBlock(fresh(), greet, 'ko'), en = runtimeBlock(fresh(), greet, 'en');
    expect(ko).toContain('이번 턴 지시: 인사·자기소개만 하십시오. 수학 문제의 답·풀이·결론(누가 더 많이 먹었는지 같은 비교 결과 포함)은 한 마디도 꺼내지 마십시오. 풀이는 사용자가 물을 때 처음 말합니다.');
    expect(en).toContain("This turn: greet back and introduce yourself briefly, nothing else. Do not mention the problem's answer, solution, or conclusion (including any comparison result). You first talk about your solution only when the user asks.");
    expect(ko).not.toContain('이번 턴 지시: 없음');
    expect(en).not.toContain('This turn: none');
    for (const b of [ko, en]) expect(b).not.toContain('""');
  });
  const seeds = { gabriel, hajun, jiwoo, noah, seoyeon };
  for (const [name, s] of Object.entries(seeds)) for (const lang of ['ko', 'en'] as const) {
    it(`${name} · ${lang}: the first greeting gets the greet directive`, () => {
      const tr = s.translations[lang], st0: SessionState = { mis: tr.misconceptions.map(() => 0), counts: {}, goalReached: false, takeOverCount: 0 };
      const j = judgeTurn(hi[lang], lang, null, tr, st0);
      expect(j).toEqual({ kind: 'turn', directive: greet, trigger: null, state: st0 });
    });
  }
});

// #100 rev 3: 사교 구절(인사·호칭·안부·교사 소개·정해진 잡담 질문)과 구분자만으로 끝까지 소비될 때만 인사 턴.
// 판정 경로(judgeTurn → greet/null)와 MOCK 경로(runTurn + mockProvider → 인사 대사인지)를 같은 표로 확인한다.
describe('greeting-only scanner (#100)', () => {
  const seeds = { gabriel, hajun, jiwoo, noah, seoyeon };
  type Seed = keyof typeof seeds;
  const mock = { provider: mockProvider, model: 'mock', effort: null };
  const bots: Bots = { student: mock, analysis: mock, mentor: mock };
  const compiled = { student: '', analysis: '', mentor: '' };
  const tr = (seed: Seed, lang: Lang) => seeds[seed].translations[lang] as Translation;
  const st0 = (t: Translation): SessionState => ({ mis: t.misconceptions.map(() => 0), counts: {}, goalReached: false, takeOverCount: 0 });
  /** MOCK 학생의 인사 대사: greet 지시를 받았을 때 고르는 대사. */
  const greetReply = (seed: Seed, lang: Lang, text: string) => { const t = tr(seed, lang);
    return mockText({ system: '', messages: [], model: 'mock', context: { role: 'student', lang, teacherText: text, leverage: null, directive: { kind: 'greet', text: '' }, goalReached: false, lines: { greet: t.greet, chars: t.chars, elicit: t.elicit, name: t.name } } }); };
  async function mockTurn(seed: Seed, lang: Lang, text: string) {
    const t = tr(seed, lang), c = seeds[seed].classification, criteria = c.leverage.length ? c : null;
    let reply: string | undefined, leverage: string | null | undefined;
    for await (const ev of runTurn({ bots, compiled, criteria, tr: t, lang, state: st0(t), history: [{ speaker: 'student', text: t.greet }], text })) {
      if (ev.type === 'student' && ev.final) reply = ev.text;
      if (ev.type === 'classification') leverage = ev.cls?.leverage ?? null;
    }
    return { reply, leverage };
  }
  async function check(seed: Seed, lang: Lang, text: string, expected: boolean) {
    const t = tr(seed, lang);
    expect(isGreetingOnly(text, lang, t.name), `${seed} ${lang} ${text}`).toBe(expected);
    const j = judgeTurn(text, lang, null, t, st0(t));
    const directive = j.kind === 'turn' ? j.directive : undefined;
    if (expected) expect(directive, text).toEqual({ kind: 'greet', text: '' }); else expect(directive?.kind, text).not.toBe('greet');
    const m = await mockTurn(seed, lang, text);
    if (expected) expect(m.reply, text).toBe(greetReply(seed, lang, text)); else expect(m.reply, text).not.toBe(greetReply(seed, lang, text));
    if (expected && m.leverage !== null) expect(m.leverage, text).toBe('Other');
    return directive;
  }

  // 리뷰어 표(RB.report.md): 시드마다 내용 질문 앞에 "안녕 "/"안녕! ", "Hi "/"Hi! " 를 붙여도 greet 가 아니다.
  const content: Record<Seed, [string, string]> = {
    gabriel: ['얼마씩 받아?', 'How much per person?'], hajun: ['누가 더 많이 먹었어?', 'Who ate more?'],
    jiwoo: ['어느 쪽이 더 많아?', 'Was it more or less?'], noah: ['어느 식탁이 더 많이 받아?', 'Which table gets more?'],
    seoyeon: ['어느 쪽이 더 길어?', 'Which is longer?'],
  };
  for (const seed of Object.keys(content) as Seed[]) for (const [lang, prefixes, q] of [['ko', ['안녕 ', '안녕! '], content[seed][0]], ['en', ['Hi ', 'Hi! '], content[seed][1]]] as const)
    for (const p of prefixes) it(`${seed} · ${lang}: ${JSON.stringify(p + q)} is not greeting-only`, () => check(seed, lang, p + q, false));

  // 조언자 표(A100.report.md): 표시한 학생이 아니면 하준.
  const rows: [boolean, string, string, Seed?][] = [
    [true, '안녕!', 'Hi!'],
    [true, '안녕, 하준아!', 'Hi, Hajun!'],
    [true, '안녕! 오늘 기분은 어때?', 'Hi! How are you?'],
    [true, '안녕하세요, 노아야! 선생님이에요.', 'Hello Noah, I am your teacher.', 'noah'],
    [true, '안녕, 이름이 뭐야?', "Hi, what's your name?"],
    [true, '몇 학년이야?', 'What grade are you in?'],
    [true, '취미가 뭐야?', "What's your hobby?"],
    [false, '안녕, 하준아! 누가 두 번째야?', 'Hi, Hajun! Who came second?'],
    [false, '안녕! 오늘 기분은 어때? 왜 그렇게 나눴어?', 'Hi! How are you? Why split it that way?'],
    [false, '안녕, 선생님이에요 몇 개 남았어?', 'Hi, my name is Kim how many are left?'],
    [false, '안녕 3+2?', 'Hi 3+2?'],
    [false, '안녕, 노아야!', 'Hi, Noah!'],
    [false, '…?!', '…?!'],
  ];
  for (const [expected, ko, en, seed = 'hajun'] of rows) for (const [lang, text] of [['ko', ko], ['en', en]] as const)
    it(`${seed} · ${lang}: ${JSON.stringify(text)} → ${expected}`, async () => {
      const d = await check(seed, lang, text, expected);
      if (!expected) expect(d).toBeNull();
    });

  it('an empty name skips the vocative pattern', () => {
    expect(isGreetingOnly('안녕!', 'ko', '')).toBe(true);
    expect(isGreetingOnly('안녕, 아!', 'ko', '')).toBe(false);
    expect(isGreetingOnly('Hi, !', 'en', '')).toBe(true);
  });
  it('"my name is" has no wildcard after it', () => {
    expect(isGreetingOnly('Hi, my name is Kim.', 'en', 'Hajun')).toBe(false);
  });
});
