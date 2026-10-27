// 프로토타입: 오버레이 주입 함수 compileScenario + 두 판 구조 점검 checkTemplates.
// 실행: node prototypes/prompt-spine/compile.mjs   (의존성 없음, Node 18+)
import { readFileSync } from 'node:fs';
import { scenario, translations } from './sample.mjs';

const NAMES = ['master', 'analysis', 'mentor'];
const tpl = (name, lang) => readFileSync(new URL(`./prompts/${name}.${lang}.md`, import.meta.url), 'utf8');
const LANG_RULE = {
  ko: '- 학생과 멘토의 모든 대사는 한국어로 작성합니다.\n- 학생은 해당 학년 아이의 자연스러운 한국어 구어체를 사용합니다.\n- [CLASSIFICATION] 블록의 키와 분류명은 정의된 그대로 유지합니다.',
  en: '- All student and mentor lines are in English only, even if the scenario setup is written in Korean.\n- The student uses the natural spoken English of a child in that grade.\n- If the user writes in Korean, the student and mentor still answer in English.\n- Keep the keys and category names of the [CLASSIFICATION] block exactly as defined.',
};
const MISSING = { ko: k => `(${k} 미입력)`, en: k => `(${k} not provided)` };
// 플레이스홀더 값 조립에 쓰는 고정 문구(언어별). 템플릿이 아니라 compile 상수다.
const T = {
  ko: { cls: (lev, obj) => `사용자의 가장 최근 메시지에 대해 다음 항목으로 분류하십시오. 각 분류의 설명과 예시를 근거로 판단합니다.\n\n레버리지(Leverage) (정확히 하나 선택):\n${list(lev)}` + (obj.length ? `\n\n대상 영역(Object) (정확히 하나 선택):\n${list(obj)}` : ''),
        rule: (lev, obj) => `출력은 정확히 다음 블록 하나뿐입니다 (백틱이나 추가 텍스트 없이):\n[CLASSIFICATION]\n{\n  "leverage": "<${names(lev)}>"${obj.length ? `,\n  "object": "<${names(obj)}>"` : ''}\n}`,
        end: lev => `사용된 레버리지 카테고리(${names(lev)})에만 집중하여 예비 교사를 위한 요약과 피드백을 2~4문장으로 씁니다.\n대상 영역(Object) 카테고리는 언급하지 마십시오.\n도달 단계(plateau), 오개념 목록, 진전 규칙을 공개하지 마십시오.\n[CLASSIFICATION] 블록이나 다른 형식 없이 문장만 출력합니다.`,
        trig: (n, t) => `트리거 1 — 주도권 빼앗기(Taking Over): 사용자가 ${n}이(가) 이해하지 못하는 형식적 방법을 강요하거나 ${n}의 전략과 거리가 먼 방법을 물었을 때.\n- 코칭 지침: ${t.t1}\n\n트리거 2 — 도움 요청: 사용자가 멘토에게 명시적으로 도움을 요청했을 때.\n- 제시할 질문 프레임:\n${frames(t.t2)}\n\n트리거 3 — 도달점 도달: 모든 오개념이 교정되었을 때.\n- 코칭 지침: ${t.t3}`,
        none: '(설명 없음)', ex: '예시' },
  en: { cls: (lev, obj) => `Classify the user's most recent message using the categories below. Judge by each category's description and examples.\n\nLeverage (choose exactly one):\n${list(lev, 'en')}` + (obj.length ? `\n\nObject (choose exactly one):\n${list(obj, 'en')}` : ''),
        rule: (lev, obj) => `Your output is exactly this one block (no backticks, no extra text):\n[CLASSIFICATION]\n{\n  "leverage": "<${names(lev)}>"${obj.length ? `,\n  "object": "<${names(obj)}>"` : ''}\n}`,
        end: lev => `Focus only on the leverage categories used (${names(lev)}) and write a 2 to 4 sentence summary with feedback for the pre-service teacher.\nDo not mention Object categories.\nDo not reveal the plateau, the misconception list, or the progression rule.\nOutput sentences only, with no [CLASSIFICATION] block or other formatting.`,
        trig: (n, t) => `Trigger 1 — Taking Over: the user pushes a formal method ${n} does not understand, or asks about a method far from ${n}'s strategy.\n- Coaching guidance: ${t.t1}\n\nTrigger 2 — Help request: the user explicitly asks the mentor for help.\n- Question frames to offer:\n${frames(t.t2)}\n\nTrigger 3 — Goal reached: every misconception has been corrected.\n- Coaching guidance: ${t.t3}`,
        none: '(no description)', ex: 'Examples' },
};
const names = rows => rows.map(r => r.name).join(' | ');
const frames = s => (s || '').split('\n').filter(Boolean).map(x => '  · ' + x).join('\n');
function list(rows, lang = 'ko') {
  return rows.map(r => { const ex = (r.ex || '').split('\n').map(x => x.trim()).filter(Boolean);
    return `- ${r.name}: ${r.desc || T[lang].none}` + (ex.length ? `\n  ${T[lang].ex}: ${ex.map(x => '"' + x + '"').join(' / ')}` : ''); }).join('\n');
}

export const placeholders = text => [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))].sort();
const sections = text => text.split('\n').filter(l => /^[A-H]\) /.test(l)).map(l => l[0]);
const fill = (text, map, lang) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => map[k] || MISSING[lang](k));

/** 검수 자동 점검 7(두 판 구조 일치): 템플릿별로 플레이스홀더 집합과 섹션 글자열이 같아야 PASS. */
export function checkTemplates() {
  return NAMES.map(name => { const ko = tpl(name, 'ko'), en = tpl(name, 'en');
    const ph = placeholders(ko).join() === placeholders(en).join(), sec = sections(ko).join() === sections(en).join();
    return { name, ok: ph && sec, placeholders: placeholders(ko), sections: sections(ko).join('') }; });
}

/** 오버레이 주입. s = scenarios 행, tr = scenario_translations 행(lang), lang = 챗봇 언어. 출력 {student, analysis|null, mentor}. */
export function compileScenario(s, tr, lang) {
  const i = s.internal || {}, lev = s.classification?.leverage || [], obj = lev.length ? (s.classification?.object || []) : [];
  const map = {
    STUDENT_PREFIX: s.student_prefix, STUDENT_NAME: tr.name, STUDENT_SHORT_DESC: tr.desc, CHARACTERISTICS: tr.chars,
    MATH_PROBLEM: tr.problem && '"' + tr.problem + '"',
    BASELINE_SOLUTION: i.baseline, DRAWING_DESCRIPTION: i.drawing, REASONING_PROFILE: i.reasoning, NEVER_UNDERSTANDS: i.never,
    PLATEAU_OR_GOAL: i.goal, PROGRESSION_RULE: i.prog,
    MISCONCEPTIONS_LIST: (i.misconceptions || []).map((m, n) => `${n + 1}) ${m.text}`).join('\n'),
    CLS_SECTION: lev.length ? T[lang].cls(lev, obj) : '', CLS_RULE: lev.length ? T[lang].rule(lev, obj) : '', END_RULE: lev.length ? T[lang].end(lev) : '',
    MENTOR_TRIGGERS: tr.name && T[lang].trig(tr.name, tr), LANG_RULE: LANG_RULE[lang],
  };
  return { student: fill(tpl('master', lang), map, lang), analysis: lev.length ? fill(tpl('analysis', lang), map, lang) : null, mentor: fill(tpl('mentor', lang), map, lang) };
}

// ---- 자가 점검 + 데모 출력 (직접 실행 시) ----
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const checks = checkTemplates();
  for (const c of checks) console.error(`[check] ${c.name}: ${c.ok ? 'PASS' : 'FAIL'} placeholders=${c.placeholders.length} sections=${c.sections}`);
  if (!checks.every(c => c.ok)) process.exit(1);
  const expect = { master: 13, analysis: 4, mentor: 3 };
  for (const c of checks) if (c.placeholders.length !== expect[c.name]) { console.error(`[check] ${c.name} expected ${expect[c.name]} placeholders`); process.exit(1); }
  for (const lang of ['ko', 'en']) {
    const out = compileScenario(scenario, translations[lang], lang);
    for (const [k, v] of Object.entries(out)) { if (v && /\{\{/.test(v)) { console.error(`[check] unfilled placeholder in ${k}.${lang}`); process.exit(1); }
      console.log(`\n##### ${k}.${lang} #####\n${v}`); }
  }
  // 분류 기준이 없으면 analysis = null, 빈 필드는 언어별 미입력 표시
  const noCls = compileScenario({ ...scenario, classification: { leverage: [], object: [] } }, { ...translations.en, chars: '' }, 'en');
  if (noCls.analysis !== null || !noCls.student.includes('(CHARACTERISTICS not provided)')) { console.error('[check] noCls/missing-field behaviour'); process.exit(1); }
  console.error('[check] all passed');
}
