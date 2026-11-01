// #67: 샘플 시나리오 greet(seq 1 학생 발화)는 맞인사·자기소개만 담는다. 첫 답(오답)·결론·근거는 elicit에만 있다.
import gabriel from '@remath/seed/scenarios/gabriel.json';
import hajun from '@remath/seed/scenarios/hajun.json';
import jiwoo from '@remath/seed/scenarios/jiwoo.json';
import noah from '@remath/seed/scenarios/noah.json';
import seoyeon from '@remath/seed/scenarios/seoyeon.json';
import { describe, expect, it } from 'vitest';
import { ScenarioInput } from './api/schemas.ts';
import { autoChecks } from './review.ts';

type Lang = 'ko' | 'en';
/** forbidden: greet에 나오면 안 되는 답·결론·근거(브리프 패턴). answer: elicit 어딘가에 남아 있어야 하는 첫 답(오답) — greet에도 나오면 안 된다. */
interface Spec { forbidden: RegExp; answer: Record<Lang, RegExp> }
const SAMPLES: [string, unknown, Spec][] = [
  ['gabriel', gabriel, { forbidden: /5\/8|받아요|each (friend )?gets/, answer: { ko: /2\/4하고 1\/8/, en: /2\/4 and 1\/8/ } }],
  ['hajun', hajun, { forbidden: /더 많이 먹|ate more|8이 4보다|8 is bigger/, answer: { ko: /동생이 더 많이 먹었/, en: /he ate more/ } }],
  ['jiwoo', jiwoo, { forbidden: /6\/10|1컵보다|less than 1 cup/, answer: { ko: /1컵보다 적어요/, en: /less than 1 cup/ } }],
  ['noah', noah, { forbidden: /더 많이 받|gets more|B 식탁이|Table B/, answer: { ko: /B가 4개 받으니까 더 많/, en: /B gets more/ } }],
  ['seoyeon', seoyeon, { forbidden: /더 길|longer|65가 7보다|65 is bigger/, answer: { ko: /0\.65가 길어요/, en: /0\.65 is longer/ } }],
];

describe('sample scenarios: greet has no first answer (#67)', () => {
  for (const [slug, json, spec] of SAMPLES) {
    const s = ScenarioInput.parse(json);
    for (const lang of ['ko', 'en'] as const) {
      const t = s.translations[lang];
      it(`${slug} ${lang}: greet is non-empty and names the student`, () => {
        expect(t.greet.trim()).not.toBe('');
        expect(t.name).not.toBe('');
        expect(t.greet).toContain(t.name);
      });
      it(`${slug} ${lang}: greet carries no answer, conclusion or reasoning`, () => {
        expect(t.greet).not.toMatch(spec.forbidden);
        expect(t.greet).not.toMatch(spec.answer[lang]);
      });
      it(`${slug} ${lang}: the first (wrong) answer is still in elicit`, () => {
        expect(t.elicit.some(line => spec.answer[lang].test(line))).toBe(true);
      });
      it(`${slug} ${lang}: review auto checks c1–c7 publishable`, () => {
        expect(autoChecks({ ...s, lang }, true).publishable).toBe(true);
      });
    }
  }
});
