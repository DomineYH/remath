// 위자드 저장 때 비어 있는 elicit 기본값(#31, 목업 upsert): 처음부터 만든 시나리오도 MOCK 학생이 idk 만 답하지 않는다.
import { describe, expect, it } from 'vitest';
import * as S from '@remath/shared';
import { withDefaultElicit } from './elicit.ts';

const draft = (lang: 'ko' | 'en', baseline = '') => S.ScenarioInput.parse({
  lang, student_prefix: '🐱', mentor_prefix: '🦉', grade: '', classification: { leverage: [], object: [] },
  internal: { baseline }, translations: { ko: { name: '서연' }, en: { name: 'Seoyeon' } },
});

describe('withDefaultElicit', () => {
  it('en edition with empty elicit → the two English default lines', () => {
    const d = withDefaultElicit(draft('en'));
    expect(d.translations.en.elicit).toEqual(['Um… I just did it the way I drew it.', "I'm pretty sure my answer is right."]);
    expect(d.translations.ko.elicit).toEqual([]);   // 다른 언어판은 건드리지 않는다
  });
  it('ko edition with empty elicit → the Korean line + the first baseline line without its leading "- "', () => {
    const d = withDefaultElicit(draft('ko', '- 0.65가 더 길다고 답함.\n- 소수점 아래를 자연수로 읽음.'));
    expect(d.translations.ko.elicit).toEqual(['음… 저는 제 그림대로 생각했어요.', '0.65가 더 길다고 답함.']);
    expect(d.translations.en.elicit).toEqual([]);
  });
  it('keeps a non-empty elicit as it is', () => {
    const d = draft('ko', '- x');
    d.translations.ko.elicit = ['제 답이 맞아요.'];
    expect(withDefaultElicit(d).translations.ko.elicit).toEqual(['제 답이 맞아요.']);
  });
});
