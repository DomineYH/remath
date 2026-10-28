// C-1: the two language editions of every template share {{KEY}} sets and A)–H) section letters (review c7). F-29~F-31: compileScenario.
import gabriel from '@remath/seed/scenarios/gabriel.json';
import hajun from '@remath/seed/scenarios/hajun.json';
import { describe, expect, it } from 'vitest';
import { checkTemplates, compileScenario, TEMPLATES } from './index.ts';

describe('C-1 checkTemplates', () => {
  it('passes for the shipped templates with 13 / 4 / 3 placeholders', () => {
    const r = checkTemplates();
    expect(r.map(c => [c.name, c.ok, c.placeholders.length])).toEqual([['master', true, 13], ['analysis', true, 4], ['mentor', true, 3]]);
  });
  it('fails when only one edition changes a placeholder or a section', () => {
    const extraKey = { ...TEMPLATES, mentor: { ...TEMPLATES.mentor, en: TEMPLATES.mentor.en + '\n{{EXTRA}}' } };
    expect(checkTemplates(extraKey).map(c => c.ok)).toEqual([true, true, false]);
    const extraSection = { ...TEMPLATES, master: { ...TEMPLATES.master, ko: TEMPLATES.master.ko + '\nZ) 추가' + '\nA) 다시' } };
    expect(checkTemplates(extraSection).map(c => c.ok)).toEqual([false, true, true]);
  });
});

describe('compileScenario', () => {
  for (const lang of ['ko', 'en'] as const) {
    it(`fills every placeholder (${lang})`, () => {
      const out = compileScenario(gabriel, gabriel.translations[lang], lang, TEMPLATES);
      for (const v of [out.student, out.analysis, out.mentor]) { expect(v).toBeTypeOf('string'); expect(v).not.toMatch(/\{\{/); }
      expect(out.student).toContain(`"${gabriel.translations[lang].problem}"`);
      expect(out.mentor).toContain(gabriel.translations[lang].t1);
    });
  }
  it('no classification → analysis null; empty field → language marker', () => {
    const out = compileScenario(hajun, { ...hajun.translations.en, chars: '' }, 'en', TEMPLATES);
    expect(out.analysis).toBeNull();
    expect(out.student).toContain('(CHARACTERISTICS not provided)');
  });
  it('uses the injected templates', () => {
    const t = { master: { ko: '{{STUDENT_NAME}}', en: '' }, analysis: { ko: 'A', en: '' }, mentor: { ko: 'M {{MENTOR_PREFIX}}', en: '' } };
    expect(compileScenario(gabriel, gabriel.translations.ko, 'ko', t)).toEqual({ student: '가브리엘', analysis: 'A', mentor: 'M (MENTOR_PREFIX 미입력)' });
  });
});
