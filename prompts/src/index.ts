// 프롬프트 스파인(F-29~F-31, ADR-0001): 템플릿 6개 + 오버레이 주입 compileScenario + 두 판 구조 점검 checkTemplates(c7).
// 템플릿은 주입받는다: 브라우저(목 API)는 아래 `?raw` 번들 TEMPLATES 를, 서버(2단계)는 같은 .md 파일을 디스크에서 읽어 넘긴다.
import type { z } from 'zod';
import type * as S from '@remath/shared';
import analysisEn from '../templates/analysis.en.md?raw';
import analysisKo from '../templates/analysis.ko.md?raw';
import masterEn from '../templates/master.en.md?raw';
import masterKo from '../templates/master.ko.md?raw';
import mentorEn from '../templates/mentor.en.md?raw';
import mentorKo from '../templates/mentor.ko.md?raw';

type Lang = 'ko' | 'en';
type Row = { name: string; desc?: string; ex?: string };
const NAMES = ['master', 'analysis', 'mentor'] as const;
export type Templates = Record<(typeof NAMES)[number], Record<Lang, string>>;
export const TEMPLATES: Templates = { master: { ko: masterKo, en: masterEn }, analysis: { ko: analysisKo, en: analysisEn }, mentor: { ko: mentorKo, en: mentorEn } };

const LANG_RULE = {
  ko: '- 학생과 멘토의 모든 대사는 한국어로 작성합니다.\n- 학생은 해당 학년 아이의 자연스러운 한국어 구어체를 사용합니다.\n- [CLASSIFICATION] 블록의 키와 분류명은 정의된 그대로 유지합니다.',
  en: '- All student and mentor lines are in English only, even if the scenario setup is written in Korean.\n- The student uses the natural spoken English of a child in that grade.\n- If the user writes in Korean, the student and mentor still answer in English.\n- Keep the keys and category names of the [CLASSIFICATION] block exactly as defined.',
};
const MISSING = { ko: (k: string) => `(${k} 미입력)`, en: (k: string) => `(${k} not provided)` };
const names = (rows: Row[]) => rows.map(r => r.name).join(' | ');
const frames = (s: string) => (s || '').split('\n').filter(Boolean).map(x => '  · ' + x).join('\n');
const list = (rows: Row[], lang: Lang) => rows.map(r => {
  const ex = (r.ex || '').split('\n').map(x => x.trim()).filter(Boolean);
  return `- ${r.name}: ${r.desc || T[lang].none}` + (ex.length ? `\n  ${T[lang].ex}: ${ex.map(x => '"' + x + '"').join(' / ')}` : '');
}).join('\n');
type Tr = Pick<z.infer<typeof S.Translation>, 'name' | 'description' | 'problem' | 'chars' | 't1' | 't2' | 't3'>;
// 플레이스홀더 값 조립에 쓰는 고정 문구(언어별). 템플릿이 아니라 compile 상수다.
const T = {
  ko: { cls: (lev: Row[], obj: Row[]) => `사용자의 가장 최근 메시지에 대해 다음 항목으로 분류하십시오. 각 분류의 설명과 예시를 근거로 판단합니다.\n\n레버리지(Leverage) (정확히 하나 선택):\n${list(lev, 'ko')}` + (obj.length ? `\n\n대상 영역(Object) (정확히 하나 선택):\n${list(obj, 'ko')}` : ''),
    rule: (lev: Row[], obj: Row[]) => `출력은 정확히 다음 블록 하나뿐입니다 (백틱이나 추가 텍스트 없이):\n[CLASSIFICATION]\n{\n  "leverage": "<${names(lev)}>"${obj.length ? `,\n  "object": "<${names(obj)}>"` : ''}\n}`,
    end: (lev: Row[]) => `사용된 레버리지 카테고리(${names(lev)})에만 집중하여 예비 교사를 위한 요약과 피드백을 2~4문장으로 씁니다.\n대상 영역(Object) 카테고리는 언급하지 마십시오.\n도달 단계(plateau), 오개념 목록, 진전 규칙을 공개하지 마십시오.\n[CLASSIFICATION] 블록이나 다른 형식 없이 문장만 출력합니다.`,
    trig: (n: string, t: Tr) => `트리거 1 — 주도권 빼앗기(Taking Over): 사용자가 ${n}이(가) 이해하지 못하는 형식적 방법을 강요하거나 ${n}의 전략과 거리가 먼 방법을 물었을 때.\n- 코칭 지침: ${t.t1}\n\n트리거 2 — 도움 요청: 사용자가 멘토에게 명시적으로 도움을 요청했을 때.\n- 제시할 질문 프레임:\n${frames(t.t2)}\n\n트리거 3 — 도달점 도달: 모든 오개념이 교정되었을 때.\n- 코칭 지침: ${t.t3}`,
    none: '(설명 없음)', ex: '예시' },
  en: { cls: (lev: Row[], obj: Row[]) => `Classify the user's most recent message using the categories below. Judge by each category's description and examples.\n\nLeverage (choose exactly one):\n${list(lev, 'en')}` + (obj.length ? `\n\nObject (choose exactly one):\n${list(obj, 'en')}` : ''),
    rule: (lev: Row[], obj: Row[]) => `Your output is exactly this one block (no backticks, no extra text):\n[CLASSIFICATION]\n{\n  "leverage": "<${names(lev)}>"${obj.length ? `,\n  "object": "<${names(obj)}>"` : ''}\n}`,
    end: (lev: Row[]) => `Focus only on the leverage categories used (${names(lev)}) and write a 2 to 4 sentence summary with feedback for the pre-service teacher.\nDo not mention Object categories.\nDo not reveal the plateau, the misconception list, or the progression rule.\nOutput sentences only, with no [CLASSIFICATION] block or other formatting.`,
    trig: (n: string, t: Tr) => `Trigger 1 — Taking Over: the user pushes a formal method ${n} does not understand, or asks about a method far from ${n}'s strategy.\n- Coaching guidance: ${t.t1}\n\nTrigger 2 — Help request: the user explicitly asks the mentor for help.\n- Question frames to offer:\n${frames(t.t2)}\n\nTrigger 3 — Goal reached: every misconception has been corrected.\n- Coaching guidance: ${t.t3}`,
    none: '(no description)', ex: 'Examples' },
};

export const placeholders = (text: string) => [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))].sort();
const sections = (text: string) => text.split('\n').filter(l => /^[A-H]\) /.test(l)).map(l => l[0]);
const fill = (text: string, map: Record<string, string | undefined>, lang: Lang) => text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => map[k] || MISSING[lang](k));

/** 검수 자동 점검 c7(두 판 구조 일치): 템플릿별로 플레이스홀더 집합과 섹션 글자열이 같아야 ok. */
export function checkTemplates(templates: Templates = TEMPLATES) {
  return NAMES.map(name => {
    const { ko, en } = templates[name];
    const ok = placeholders(ko).join() === placeholders(en).join() && sections(ko).join() === sections(en).join();
    return { name, ok, placeholders: placeholders(ko), sections: sections(ko).join('') };
  });
}

/** 오버레이 주입(F-29). s = 시나리오(ScenarioInput 모양), tr = 그 lang 언어판, lang = 챗봇 언어. 분류 기준이 없으면 analysis = null. mentor_prefix 는 주입하지 않는다(UI 전용). */
export function compileScenario(s: Pick<z.infer<typeof S.ScenarioInput>, 'student_prefix' | 'internal' | 'classification'>, tr: Tr, lang: Lang, templates: Templates): z.infer<typeof S.Compiled> {
  const i = s.internal, lev = s.classification.leverage, obj = lev.length ? s.classification.object : [];
  const map = {
    STUDENT_PREFIX: s.student_prefix, STUDENT_NAME: tr.name, STUDENT_SHORT_DESC: tr.description, CHARACTERISTICS: tr.chars,
    MATH_PROBLEM: tr.problem && '"' + tr.problem + '"',
    BASELINE_SOLUTION: i.baseline, DRAWING_DESCRIPTION: i.drawing, REASONING_PROFILE: i.reasoning, NEVER_UNDERSTANDS: i.never,
    PLATEAU_OR_GOAL: i.goal, PROGRESSION_RULE: i.prog,
    MISCONCEPTIONS_LIST: i.misconceptions.map((m, n) => `${n + 1}) ${m.text}`).join('\n'),
    CLS_SECTION: lev.length ? T[lang].cls(lev, obj) : '', CLS_RULE: lev.length ? T[lang].rule(lev, obj) : '', END_RULE: lev.length ? T[lang].end(lev) : '',
    MENTOR_TRIGGERS: tr.name && T[lang].trig(tr.name, tr), LANG_RULE: LANG_RULE[lang],
  };
  return { student: fill(templates.master[lang], map, lang), analysis: lev.length ? fill(templates.analysis[lang], map, lang) : null, mentor: fill(templates.mentor[lang], map, lang) };
}
