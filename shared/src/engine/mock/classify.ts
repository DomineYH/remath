// 목업 detectStd/detectEn/pickCat/exMatch 이식. MOCK 분석 챗봇 전용(실 경로는 LLM이 분류).
// 도움 요청·END SESSION 감지는 여기 없다 — 서버 상수(engine.ts).
import type { Criteria, Lang } from '../adapter.ts';
import type { Classification } from '../classification.ts';
import { LEVERAGE } from '../../leverage.ts';

interface Std { leverage: string; object: string; greet?: boolean }

export function detectKo(m: string): Std {
  const t = m.trim();
  const obj = /더하|빼|합쳐|합치|\+/.test(t) ? 'Add/Subtract' : /비교|더 큰|더 많|같을까|같은지|똑같|다를까|어느 쪽|누가 더/.test(t) ? 'Compare' : /그림|직사각형|네모|원을|막대|색칠|그려|겹쳐|수직선|자에/.test(t) ? 'Diagram' : /나눠 ?줘|배분|나누어 (주|갖)|몫|한 명이 받|한 사람이 받/.test(t) ? 'Distribution' : /공식|통분|분모|분자|식을|식으로|소수로|0을 붙/.test(t) ? 'Formula Related' : /전체|한 컵|1컵|부분|피자 한 판|바 하나|전부/.test(t) ? 'Parts & Whole' : /등분|자르|조각|반으로|칸으로|몇 개로/.test(t) ? 'Partition' : /답|결론|얼마|몇 ?m|누가|어느 리본|어느 식탁/.test(t) ? 'Solution' : 'Other';
  if (/안녕|반가|이름이 뭐|몇 학년|좋아하|취미|키워|강아지|고양이|거북이|푸들/.test(t) && !/문제|풀|조각|분수/.test(t)) return { leverage: 'Other', object: 'Other', greet: true };
  if (/통분|공통분모|공식|분모를 (같게|맞추)|더하면 돼|빼면 돼|곱하면 돼|나누면 돼|답은 |정답은|이렇게 (풀|하면)|해야 (해|돼)|외워|따라 해|계산해 봐|알려줄게|가르쳐 줄게|소수로 바꿔|0을 붙여|규칙은|분모가 크면 작/.test(t)) return { leverage: LEVERAGE.takingOver, object: obj };
  if (/같을까|다를까|비교|만약|반으로|자르면|나누면 어떻게|전체|한 컵|1컵|더 큰|더 많|기준|절반|똑같은 크기|같은 크기|크기가|겹쳐|나란히|바꿀 수|몇 개로 바꿀|수직선|찍으면|더 작|더 크/.test(t)) return { leverage: LEVERAGE.extending, object: obj };
  if (/왜|어떻게|무슨|뭐|어떤|설명|보여|말해|생각|나타내|의미|어디/.test(t) || /\?$/.test(t)) return { leverage: LEVERAGE.eliciting, object: obj };
  return { leverage: 'Other', object: 'Other' };
}

export function detectEn(m: string): Std {
  const t = m.trim(), l = t.toLowerCase();
  const obj = /\badd|plus|subtract|minus|together|combine|in all|\+/.test(l) ? 'Add/Subtract'
    : /compar|bigger|larger|smaller|more than|less than|same|equal|which (one|is|table|ribbon)|who (ate|got|gets) more|longer/.test(l) ? 'Compare'
    : /draw|picture|rectangle|circle|\bbars?\b|shade|colou?r|number line|ruler|overlap/.test(l) ? 'Diagram'
    : /share|each (friend|kid|person|child) get|give out|hand out|distribut/.test(l) ? 'Distribution'
    : /formula|denominator|numerator|common|equation|decimal|algorithm|add a zero/.test(l) ? 'Formula Related'
    : /whole|one cup|1 cup|entire|part of/.test(l) ? 'Parts & Whole'
    : /\bcut|piece|split|half|halves|equal parts/.test(l) ? 'Partition'
    : /answer|result|how much|how long|\bwho\b|which/.test(l) ? 'Solution' : 'Other';
  if (/\b(hi|hello|hey|nice to meet|your name|what grade|favorite|pets?|dog|cat|turtle|poodle|soccer|tennis|baseball)\b/.test(l) && !/problem|solve|piece|fraction|cup|pizza|ribbon|candy/.test(l)) return { leverage: 'Other', object: 'Other', greet: true };
  if (/common denominator|find a common|the answer is|just (add|subtract|multiply)|you (should|need to|have to)|the rule is|use the formula|convert (it )?to|add a zero|let me show you|i'll show you|multiply the|bigger denominator means|memori[sz]e/.test(l)) return { leverage: LEVERAGE.takingOver, object: obj };
  if (/what if|compare|bigger|larger|smaller|more than|less than|the same|equal|half|halves|whole|one cup|benchmark|overlap|side by side|on top|number line|ruler|line them up|if you cut|cut .* in half|closer to/.test(l)) return { leverage: LEVERAGE.extending, object: obj };
  if (/\b(why|how|what|which|where|tell me|explain|show me|describe|mean|think)\b/.test(l) || /\?$/.test(t)) return { leverage: LEVERAGE.eliciting, object: obj };
  return { leverage: 'Other', object: 'Other' };
}

const STD_NAMES = new Set(['Eliciting', 'Extending', 'Taking Over', 'Other', 'Add/Subtract', 'Compare', 'Diagram', 'Distribution', 'Formula Related', 'Parts & Whole', 'Partition', 'Solution']);
function exMatch(ex: string | undefined, m: string): boolean {
  return (ex ?? '').split('\n').map(x => x.trim()).filter(Boolean).some(line => {
    const ws = line.toLowerCase().split(/[\s?.!,~…"'“”’]+/).map(w => w.replace(/(을|를|이|가|은|는|에|도|로|의|야|요)$/, '')).filter(w => /[가-힣]/.test(w) ? w.length >= 2 : w.length >= 4);
    const lm = m.toLowerCase(), hit = ws.filter(w => lm.includes(w)).length; return hit >= 2 || (ws.length === 1 && hit === 1);
  });
}
/** 관리자 정의 분류명: 표준 이름은 규칙으로, 사용자 정의 이름은 예시 발문 매칭으로. */
function pickCat(rows: { name: string; ex?: string }[], std: string, m: string): string {
  for (const r of rows) if (!STD_NAMES.has(r.name) && exMatch(r.ex, m)) return r.name;
  const names = rows.map(r => r.name); if (names.includes(std)) return std; return names.includes('Other') ? 'Other' : names[names.length - 1];
}

export function mockClassify(text: string, lang: Lang, criteria: Criteria): Classification {
  const d = (lang === 'en' ? detectEn : detectKo)(text);
  return { leverage: pickCat(criteria.leverage, d.leverage, text), object: criteria.object.length ? pickCat(criteria.object, d.object, text) : null };
}

/** 인사 휴리스틱은 분류가 아니라 MOCK 학생이 "무슨 말을 할지" 고르는 데 쓴다. */
export function isGreeting(text: string, lang: Lang): boolean { return !!(lang === 'en' ? detectEn : detectKo)(text).greet; }
export function stdLeverage(text: string, lang: Lang): string { return (lang === 'en' ? detectEn : detectKo)(text).leverage; }
