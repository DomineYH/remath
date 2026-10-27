// 자가 점검: 목업의 기록 시뮬레이션 L1(도달)·L2(Taking Over)을 새 파이프라인(규칙 엔진 + MOCK 어댑터)으로 재생해 목업과 같은 대사가 나오는지,
// MOCK 출력이 실 LLM 출력 파서를 그대로 지나는지 확인한다. 실행: node prototypes/llm-adapter/check.ts   (Node 24, 의존성 없음)
import assert from 'node:assert/strict';
import { AdapterError, collect, type Criteria } from './src/adapter.ts';
import { parseClassification } from './src/classification.ts';
import { judgeTurn, type SessionState } from './src/engine.ts';
import { mockProvider, TXT } from './src/mock/provider.ts';
import { runTurn, type Turn, type TurnEvent } from './src/pipeline.ts';
import { scenario, translations } from './sample.mjs';

const criteria: Criteria = scenario.classification;
const bots = { student: mockProvider, analysis: mockProvider, mentor: mockProvider, model: 'mock' };
const compiled = { student: '<student system>', analysis: '<analysis system>', mentor: '<mentor system>' }; // 내용은 MOCK 이 읽지 않는다(선택지 A)

async function replay(lang: 'ko' | 'en', qs: string[], crit: Criteria | null) {
  const tr = translations[lang];
  let state: SessionState = { mis: tr.misconceptions.map(() => 0), counts: {}, goalReached: false, takeOverCount: 0 };
  const history: Turn[] = [{ speaker: 'student', text: tr.greet }], log: TurnEvent[][] = [];
  let summary: string | undefined;
  for (const q of qs) {
    const evs: TurnEvent[] = [];
    for await (const ev of runTurn({ bots, compiled, criteria: crit, tr, lang, state, history, text: q })) evs.push(ev);
    log.push(evs); history.push({ speaker: 'teacher', text: q });
    for (const ev of evs) { if (ev.type === 'student') history.push({ speaker: 'student', text: ev.text }); if (ev.type === 'mentor') history.push({ speaker: 'mentor', text: ev.text }); if (ev.type === 'done') { state = ev.state; summary = ev.summary; } }
  }
  return { log, state, summary, history };
}
const student = (evs: TurnEvent[]) => (evs.find(e => e.type === 'student') as any)?.text;
const mentor = (evs: TurnEvent[]) => (evs.find(e => e.type === 'mentor') as any)?.text;
const lev = (evs: TurnEvent[]) => (evs.find(e => e.type === 'classification') as any)?.cls?.leverage;
const trig = (evs: TurnEvent[]) => (evs.find(e => e.type === 'trigger') as any)?.trigger;

// ---- L1: 목업 기록 "가브리엘 · 도달" ----
{
  const ko = translations.ko, m = ko.misconceptions;
  const r = await replay('ko', ['안녕, 네 이름이 뭐야?', '어떻게 풀었는지 말해 줄래?', '한 친구가 받는 걸 모두 합치면 얼마야?', '그러면 한 사람이 받는 게 전부 얼마인지 하나로 말해 볼래?', '4분의 1 조각을 반으로 자르면 어떻게 될까?', '그 조각을 더 작게 자르면 8분의 1이 몇 개야?', '8분의 1 조각이 다 해서 몇 개야?', '모두 몇 조각인지 세어 볼래?', 'END SESSION'], criteria);
  assert.equal(student(r.log[0]), '안녕하세요… 저는 가브리엘이에요.');           // 인사 휴리스틱(지시 없음)
  assert.equal(student(r.log[1]), ko.elicit[0]);                                  // Eliciting, 키워드 없음 → elicit 회전
  assert.equal(student(r.log[2]), m[0].h); assert.equal(student(r.log[3]), m[0].c); // 오개념 1: h → c
  assert.equal(student(r.log[4]), m[1].h); assert.equal(student(r.log[5]), m[1].c);
  assert.equal(student(r.log[6]), m[2].h); assert.equal(student(r.log[7]), `${m[2].c}\n${ko.aha}`); // 도달: c + aha 한 응답
  assert.equal(trig(r.log[7]), 3); assert.equal(mentor(r.log[7]), ko.t3);        // 트리거 3 → 멘토 t3
  assert.deepEqual(r.log.slice(0, 8).map(lev), ['Other', 'Eliciting', 'Eliciting', 'Eliciting', 'Extending', 'Extending', 'Eliciting', 'Eliciting']);
  assert.deepEqual(r.state, { mis: [2, 2, 2], counts: { Other: 1, Eliciting: 5, Extending: 2 }, goalReached: true, takeOverCount: 0 });
  assert.equal(r.summary, `${TXT.ko.clean(5, 2)}\n${TXT.ko.endReached}`);        // [REPORT] → 목업 문장
  assert.ok(!r.history.some(t => t.text.startsWith('Mentor:') || t.text.startsWith('멘토:')), 'no speaker prefix');
}
// ---- L2: 목업 기록 "Taking Over 2회" ----
{
  const ko = translations.ko;
  const r = await replay('ko', ['안녕!', '통분하면 돼. 분모를 같게 만들어 봐.', '2/4는 4/8이니까 더하면 5/8이야. 답은 5/8이야.', '그림을 어떻게 그렸어?', 'END SESSION'], criteria);
  assert.equal(student(r.log[1]), ko.confused[0]); assert.equal(trig(r.log[1]), 1); assert.equal(mentor(r.log[1]), ko.t1);
  assert.equal(student(r.log[2]), ko.confused[1]);                                // 혼란 대사 회전 = 트리거 1 횟수
  assert.equal(student(r.log[3]), ko.elicit[0]);
  assert.equal(r.summary, `${TXT.ko.heavy(2, 1)}\n${TXT.ko.endNot}`);
}
// ---- 도움 요청(트리거 2): 학생 LLM 미호출·고정 문구, 멘토 t2 프레임. 영어판·분류 기준 없는 시나리오에서도 동작. ----
{
  const en = translations.en;
  const r = await replay('en', ['Help', 'Can you tell me how you solved it?'], null);
  assert.equal(student(r.log[0]), TXT.en.help); assert.equal(trig(r.log[0]), 2);
  assert.equal(mentor(r.log[0]), `${TXT.en.helpLead}\n${en.t2.split('\n').map(x => '· ' + x).join('\n')}`);
  assert.equal(lev(r.log[0]), undefined);                                         // 분류 기준 없음 → 분석 호출 없음
  assert.equal(student(r.log[1]), en.elicit[0]); assert.equal(r.state.counts.Eliciting, undefined);
  // 도달 후: 카운터·트리거 없이 reached 대사 회전
  const st: SessionState = { mis: [2, 2, 2], counts: {}, goalReached: true, takeOverCount: 0 };
  const j = judgeTurn('Just add them, the answer is 5/8.', 'en', { leverage: 'Taking Over', object: null }, en, st);
  assert.deepEqual(j, { kind: 'turn', directive: null, trigger: null, state: { ...st, counts: { 'Taking Over': 1 } } }); // 레버리지 카운트만 오른다
}
// ---- 파서: MOCK 출력과 실 LLM 스타일 출력이 같은 함수를 지난다 ----
{
  const req = { system: '', messages: [], model: 'mock', context: { role: 'analysis' as const, lang: 'ko' as const, purpose: 'turn' as const, teacherText: '통분하면 돼.', criteria } };
  const { text, done } = await collect(mockProvider.complete(req));
  assert.deepEqual(parseClassification(text, criteria), { leverage: 'Taking Over', object: 'Formula Related' });
  assert.equal(done.type, 'done');
  assert.deepEqual(parseClassification('Sure!\n```\n[CLASSIFICATION]\n{"leverage":"Eliciting","object":"Diagram","targets_misconception":2}\n```', criteria), { leverage: 'Eliciting', object: 'Diagram' }); // 백틱·잡담·미지 키 허용
  assert.equal(parseClassification('[CLASSIFICATION]\n{"leverage":"Probing"}', criteria), null);  // 기준에 없는 이름 → 재요청 대상
  assert.equal(parseClassification('[CLASSIFICATION]\n{"leverage":"Eliciting"', criteria), null); // 깨진 JSON
  assert.deepEqual(parseClassification('[CLASSIFICATION]\n{"leverage":"Other"}', { leverage: criteria.leverage, object: [] }), { leverage: 'Other', object: null }); // object 기준 없음
  // 실패 2회 → Other 로 기록하고 진행(PRD 8절). 깨진 출력을 내는 가짜 어댑터로 확인.
  const broken = { ...mockProvider, async *complete(r: any) { yield { type: 'delta' as const, text: 'garbage' }; yield { type: 'done' as const, model: 'x', stopReason: 'end' as const }; } };
  const evs: TurnEvent[] = []; for await (const ev of runTurn({ bots: { ...bots, analysis: broken }, compiled, criteria, tr: translations.ko, lang: 'ko', state: { mis: [0, 0, 0], counts: {}, goalReached: false, takeOverCount: 0 }, history: [], text: '왜 그렇게 생각했어?' })) evs.push(ev);
  assert.deepEqual((evs[0] as any).cls, { leverage: 'Other', object: 'Other' });
  // context 없는 MOCK 호출은 오류(실 어댑터는 context 를 무시하므로 반대 방향은 문제 없음)
  await assert.rejects(collect(mockProvider.complete({ system: '', messages: [], model: 'mock' })), (e: unknown) => e instanceof AdapterError && e.code === 'no_context');
  const ac = new AbortController(); ac.abort();
  await assert.rejects(collect(mockProvider.complete({ ...req, signal: ac.signal })));
}
console.log('[check] all passed');
