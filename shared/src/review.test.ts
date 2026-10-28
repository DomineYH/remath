// D-23: review auto checks c1–c7 on the active chatbot-language edition (c7 = template structure, passed in by the caller).
import hajun from '@remath/seed/scenarios/hajun.json';
import seoyeon from '@remath/seed/scenarios/seoyeon.json';
import { describe, expect, it } from 'vitest';
import { autoChecks } from './review.ts';
import { ScenarioInput } from './api/schemas.ts';

const S = ScenarioInput.parse(seoyeon);
type Input = typeof S;
const status = (s: Input, c7 = true) => Object.fromEntries(autoChecks(s, c7).auto.map(c => [c.id, c.status]));
const ko = (patch: Partial<Input['translations']['ko']>): Input => ({ ...S, translations: { ...S.translations, ko: { ...S.translations.ko, ...patch } } });

describe('autoChecks', () => {
  it('Seoyeon passes all seven and is publishable', () => {
    expect(autoChecks(S, true)).toEqual({ auto: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'].map(id => ({ id, status: 'pass' })), publishable: true });
  });
  it('no classification → c6 info, still publishable', () => {
    const r = autoChecks(ScenarioInput.parse(hajun), true);
    expect(r.auto.find(c => c.id === 'c6')?.status).toBe('info');
    expect(r.publishable).toBe(true);
  });
  const fails: [string, Input, boolean?][] = [
    ['c1', { ...S, internal: { ...S.internal, goal: '' } }],
    ['c1', ko({ problem: '' })],
    ['c2', ko({ misconceptions: S.translations.ko.misconceptions.map((m, i) => i ? m : { ...m, h: '' }) })],
    ['c2', { ...S, internal: { ...S.internal, misconceptions: [] }, translations: { ko: { ...S.translations.ko, misconceptions: [] }, en: { ...S.translations.en, misconceptions: [] } } }],
    ['c3', ko({ t2: '' })],
    ['c4', ko({ confused: [] })],
    ['c4', { ...S, internal: { ...S.internal, never: '' } }],
    ['c5', ko({ aha: '통분하면 같아요!' })],
    ['c6', { ...S, classification: { ...S.classification, object: [{ name: 'X', desc: 'd', ex: '' }] } }],
    ['c7', S, false],
  ];
  for (const [id, input, c7] of fails) {
    it(`${id} fails`, () => {
      const st = status(input, c7 ?? true);
      expect(st[id]).toBe('fail');
      expect(Object.entries(st).filter(([, v]) => v === 'fail').map(([k]) => k)).toEqual([id]);
      expect(autoChecks(input, c7 ?? true).publishable).toBe(false);
    });
  }
  it('judges the active language edition only', () => {
    const enOnlyBroken: Input = { ...S, translations: { ...S.translations, en: { ...S.translations.en, t1: '' } } };
    expect(status(enOnlyBroken).c3).toBe('pass');
    expect(status({ ...enOnlyBroken, lang: 'en' }).c3).toBe('fail');
  });
});
