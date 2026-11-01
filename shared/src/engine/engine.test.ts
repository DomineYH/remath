// #68: 아하 턴(마지막 오개념 2회차로 모두 교정) 지시는 aha 한 줄. aha 가 비면 마지막 c 로 대신한다. 남은 오개념이 있으면 교정 지시 그대로.
import gabriel from '@remath/seed/scenarios/gabriel.json';
import hajun from '@remath/seed/scenarios/hajun.json';
import jiwoo from '@remath/seed/scenarios/jiwoo.json';
import noah from '@remath/seed/scenarios/noah.json';
import seoyeon from '@remath/seed/scenarios/seoyeon.json';
import { describe, expect, it } from 'vitest';
import { isGreetingOnly, judgeTurn, runtimeBlock, type SessionState } from './index.ts';

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
    expect(isGreetingOnly('안녕, 피자 문제 어떻게 풀었어?', 'ko')).toBe(false);
    const j = judgeTurn('안녕, 피자 문제 어떻게 풀었어?', 'ko', null, gabriel.translations.ko, fresh());
    expect(j.kind === 'turn' && j.directive).toBeNull();
    expect(isGreetingOnly('Hi! How did you solve the pizza problem?', 'en')).toBe(false);
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
