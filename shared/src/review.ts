// 검수 자동 점검 c1~c7(D-23, 목업 autoChecks 이식). 활성 챗봇 언어판(s.lang)을 판정한다.
// c7(두 판 템플릿 구조 일치)은 prompts 의 checkTemplates() 결과를 호출자가 넘긴다 — shared 는 prompts 에 의존하지 않는다.
import type { z } from 'zod';
import type { ReviewResult, ScenarioInput } from './api/schemas.ts';

const ADULT_TERMS = /통분하면|공식은|알고리즘은|최소공배수|common denominator|least common multiple|the algorithm/i;

export function autoChecks(s: z.infer<typeof ScenarioInput>, templatesOk: boolean): z.infer<typeof ReviewResult> {
  const t = s.translations[s.lang], i = s.internal, cls = s.classification;
  const checks: [string, boolean | 'info'][] = [
    ['c1', !!(t.name && t.problem && i.baseline && i.reasoning && i.goal)],
    ['c2', t.misconceptions.length > 0 && t.misconceptions.every(m => m.kw && m.h && m.c)],
    ['c3', !!(t.t1 && t.t2 && t.t3)],
    ['c4', !!(i.never && t.confused.length)],
    ['c5', !ADULT_TERMS.test([t.aha, ...t.misconceptions.map(m => m.c)].join(' '))],
    ['c6', cls.leverage.length ? [...cls.leverage, ...cls.object].every(r => r.desc && r.ex) : 'info'],
    ['c7', templatesOk],
  ];
  const auto = checks.map(([id, ok]) => ({ id: id as `c${1 | 2 | 3 | 4 | 5 | 6 | 7}`, status: ok === 'info' ? 'info' as const : ok ? 'pass' as const : 'fail' as const }));
  return { auto, publishable: auto.every(c => c.status !== 'fail') };
}
