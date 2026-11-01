// #68: 아하 턴(마지막 오개념 2회차로 모두 교정) 지시는 aha 한 줄. aha 가 비면 마지막 c 로 대신한다. 남은 오개념이 있으면 교정 지시 그대로.
import gabriel from '@remath/seed/scenarios/gabriel.json';
import { describe, expect, it } from 'vitest';
import { judgeTurn, runtimeBlock, type SessionState } from './index.ts';

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
