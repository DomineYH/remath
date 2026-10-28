// 위자드 저장 때 elicit 기본값(#31): 목업 upsert 규칙 그대로. 목 API·서버 규칙은 바뀌지 않는다.
import type * as S from '@remath/shared';
import type { z } from 'zod';

type Draft = z.infer<typeof S.ScenarioInput>;

/** 지금 봇 언어판의 elicit 이 비었으면 기본 두 줄을 채운다(ko 둘째 줄 = baseline 첫 줄에서 앞 "- " 를 뺀 것). 비어 있지 않으면 그대로. */
export function withDefaultElicit(d: Draft): Draft {
  const tr = d.translations[d.lang];
  if (tr.elicit.length) return d;
  const elicit = d.lang === 'en'
    ? ['Um… I just did it the way I drew it.', "I'm pretty sure my answer is right."]
    : ['음… 저는 제 그림대로 생각했어요.', d.internal.baseline.split('\n')[0].replace(/^- /, '')];
  return { ...d, translations: { ...d.translations, [d.lang]: { ...tr, elicit } } };
}
