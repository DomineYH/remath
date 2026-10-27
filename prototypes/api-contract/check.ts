// 점검: 어디든 zod@4 를 설치한 뒤 `ln -s <그 폴더>/node_modules prototypes/api-contract/node_modules // 점검: NODE_PATH=<zod 설치 폴더>/node_modules node prototypes/api-contract/check.ts  (Node 24, 저장소에는 의존성을 넣지 않는다)// 점검: NODE_PATH=<zod 설치 폴더>/node_modules node prototypes/api-contract/check.ts  (Node 24, 저장소에는 의존성을 넣지 않는다) node prototypes/api-contract/check.ts` (Node 24, 저장소에는 의존성을 넣지 않는다. 심링크는 커밋하지 않는다)
// 1) 예비교사 실(realm teacher|any)의 응답 스키마 어디에도 internal·compiled_prompt·progress·counts 키가 없다(ADR-0003, 티켓 13 의 테스트 1개를 계약 수준에서 먼저).
// 2) 닉네임·비밀번호 규칙(PRD 9절). 3) SSE 이벤트 샘플이 유니온을 지난다. 4) ScenarioInput 의 오개념 정렬 refine. 5) 경로·메서드 중복 없음.
import assert from 'node:assert/strict';
import { z } from 'zod';
import * as S from './src/schemas.ts';
import { routes } from './src/routes.ts';

const FORBIDDEN = new Set(['internal', 'compiled_prompt', 'progress', 'counts', 'password_hash', 'key_ciphertext', 'token_hash']);
/** zod 스키마 트리를 걸어 object 키를 모은다(array·nullable·union·extend 통과). */
function keys(schema: z.ZodType, out = new Set<string>()): Set<string> {
  const d: any = (schema as any).def ?? (schema as any)._def;
  if (!d) return out;
  if (d.type === 'object') for (const [k, v] of Object.entries(d.shape)) { out.add(k); keys(v as z.ZodType, out); }
  for (const inner of [d.element, d.innerType, d.in, d.out]) if (inner) keys(inner, out);
  if (d.options) for (const o of d.options) keys(o, out);
  return out;
}

// 1) 예비교사 노출면
for (const r of routes) {
  if (r.realm === 'admin' || typeof r.response === 'string') continue;
  const hit = [...keys(r.response)].filter(k => FORBIDDEN.has(k));
  assert.deepEqual(hit, [], `${r.method} ${r.path} leaks ${hit}`);
}
assert.deepEqual([...keys(S.SseEvent)].filter(k => FORBIDDEN.has(k)), [], 'SSE leaks internal state');
assert.ok(keys(S.ScenarioAdmin).has('internal'), 'admin type keeps internal');

// 2) 닉네임·비밀번호
for (const ok of ['하늘쌤', 'ab', 'a_b.c-1', '1234567']) assert.ok(S.Nickname.safeParse(ok).success === !/\d{7}/.test(ok), ok);
for (const bad of ['a', 'a@b.c', '12345678', 'x'.repeat(17), 'has space']) assert.ok(!S.Nickname.safeParse(bad).success, bad);
for (const ok of ['abcd1234', 'Pa55word!', 'a1b2c3d4e5']) assert.ok(S.Password.safeParse(ok).success, ok);
for (const bad of ['abcdefgh', '12345678', 'abc 1234', 'ab12']) assert.ok(!S.Password.safeParse(bad).success, bad);

// 3) SSE 샘플
const now = new Date().toISOString();
const turn = { seq: 2, speaker: 'teacher', text: '왜 그렇게 생각했어?', leverage: 'Eliciting', object: null, trigger: null, created_at: now };
for (const ev of [
  { type: 'classification', leverage: 'Eliciting', object: null },
  { type: 'student', text: '음…', final: false }, { type: 'student', text: '음… 저 아직 생각 중이에요.', final: true },
  { type: 'trigger', trigger: 2 }, { type: 'mentor', text: '이렇게 물어보세요: · …', final: true },
  { type: 'done', ended: false, turns: [turn] },
  { type: 'done', ended: true, report: { total: 5, reached: true, verdict: 'clean', rows: [{ name: 'Eliciting', desc: '', count: 5, turns: [{ seq: 2, text: '…' }] }], summary: null } },
  { type: 'done', ended: true, report: null },
  { type: 'error', code: 'provider_unavailable', message: 'upstream 503', retryable: true },
]) assert.ok(S.SseEvent.safeParse(ev).success, JSON.stringify(ev));
assert.ok(!S.SseEvent.safeParse({ type: 'done', ended: true, turns: [] }).success, 'ended:true must carry report');
assert.ok(!S.SseEvent.safeParse({ type: 'state', mis: [1] }).success, 'state event not in teacher union yet (ticket 15)');

// 4) ScenarioInput 정렬 refine
const tr = (n: number) => ({ misconceptions: Array.from({ length: n }, () => ({ kw: 'k', h: 'h', c: 'c' })) });
const input = (n: number) => ({ lang: 'ko', student_prefix: '🦊', mentor_prefix: '🦉', grade: '5', internal: { misconceptions: [{ text: 'm1' }] }, classification: { leverage: [], object: [] }, translations: { ko: tr(n), en: tr(n) } });
assert.ok(S.ScenarioInput.safeParse(input(1)).success); assert.ok(!S.ScenarioInput.safeParse(input(2)).success);

// 5) 표 무결성
const seen = new Set<string>();
for (const r of routes) { const k = `${r.method} ${r.path}`; assert.ok(!seen.has(k), `dup ${k}`); seen.add(k); assert.ok(r.path.startsWith('/api/')); }
assert.ok(routes.filter(r => r.path.startsWith('/api/admin/')).every(r => r.realm === 'admin' || r.path.endsWith('/auth/login')), '/api/admin/* is admin-only');

console.log(`OK — ${routes.length} routes, ${routes.filter(r => r.realm !== 'admin').length} teacher-reachable, no internal keys exposed`);
