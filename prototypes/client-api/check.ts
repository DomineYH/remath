// 점검: 어디든 zod@4 를 설치하고 `ln -s <그 폴더>/node_modules node_modules` (저장소 루트, 커밋하지 않음) 뒤 `node prototypes/client-api/check.ts` (Node 24).
// 1) 인터페이스 ↔ 라우트 표 1:1. 2) 목의 예비교사 응답·SSE 이벤트 어디에도 internal·compiled_prompt·progress·counts 없음(티켓 4항) + ScenarioPublic strict.
// 3) 목이 서버 규칙을 흉내: 인사 seq 1, 409 session_active, current 복구, 턴 SSE 모양, 도달 → 트리거 3, END → 리포트, PUT→draft, 삭제 409, 턴 상한, 검증 400.
// 4) 교체 지점: createApi 는 VITE_MOCK_API 하나로 갈린다. 5) HTTP 구현: 경로·헤더·쿼리·SSE 파서·오류. 6) localStorage 한 키로 저장·복원, 시드 재생.
import assert from 'node:assert/strict';
import { routes } from '../api-contract/src/routes.ts';
import * as S from '../api-contract/src/schemas.ts';
import { translations as gabrielTr } from '../llm-adapter/sample.mjs';
import { createHttpApi, sse } from './src/api/http.ts';
import { createApi } from './src/api/index.ts';
import { createMockApi, seedSessions } from './src/api/mock/index.ts';
import { memoryStorage, SEED_IDS, seedDb, Store, STORAGE_KEY } from './src/api/mock/store.ts';
import { API_ROUTES, ApiError, type SseEvent } from './src/api/types.ts';

const FORBIDDEN = new Set(['internal', 'compiled_prompt', 'progress', 'counts', 'password', 'password_hash']);
const leaks = (v: unknown, path = '$', out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x, i) => leaks(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (FORBIDDEN.has(k)) out.push(`${path}.${k}`); leaks(x, `${path}.${k}`, out); }
  return out;
};
const rejects = async (p: Promise<unknown> | AsyncIterable<unknown>, code: string, status?: number) => {
  try { if (Symbol.asyncIterator in p) await (p as AsyncIterable<unknown>)[Symbol.asyncIterator]().next(); else await p; } catch (e) { assert.ok(e instanceof ApiError, String(e)); assert.equal(e.code, code); if (status) assert.equal(e.status, status); return e; }
  assert.fail(`expected ${code}`);
};
let tick = 0; const now = () => new Date(Date.UTC(2026, 9, 28, 0, 0, tick++)).toISOString();

// 1) 인터페이스 ↔ 라우트 표
{
  const table = new Set(Object.values(API_ROUTES)), real = new Set(routes.map(r => `${r.method} ${r.path}`));
  assert.deepEqual([...table].sort(), [...real].sort(), 'API_ROUTES must equal the route table');
  assert.equal(Object.keys(API_ROUTES).length, routes.length);
}

// 2)·3)·6) 목 구현
const storage = memoryStorage();
const store = new Store(storage, () => seedDb());
const teacher = createMockApi({ realm: 'teacher', store, now }), admin = createMockApi({ realm: 'admin', store, now });
const ko = gabrielTr.ko;
{
  await rejects(teacher.me(), 'unauthorized', 401);
  await rejects(teacher.login({ nickname: '하늘쌤', password: 'wrong123' }), 'invalid_credentials', 401);
  await rejects(teacher.signup({ nickname: 'a@b', password: 'abcd1234' }), 'validation_failed', 400);   // 라우트 표 스키마로 본문 검증
  await rejects(teacher.signup({ nickname: '하늘쌤', password: 'abcd1234' }), 'nickname_taken', 409);
  const me = await teacher.login({ nickname: '하늘쌤', password: 'demo123!' });
  assert.equal(me.role, 'teacher'); assert.equal(me.id, SEED_IDS.u(1));
  await admin.adminLogin({ nickname: 'admin', password: 'admin12!' });

  // 예비교사 노출면: scenarios_public 열만
  const home = await teacher.getPractice();
  assert.deepEqual(leaks(home), []);
  assert.equal(home.scenarios.length, 1);
  S.ScenarioPublic.extend({ group_ids: S.Uuid.array() }).strict().parse(home.scenarios[0]);           // 티켓 4항: 여분 키도 없음
  assert.deepEqual(home.groups.map(g => g.name), ['2학년 수학교육 A반', '국제교류 (English)']);

  // 연습 세션: 인사 seq 1, 진행 중 1개, current 복구
  assert.equal(await teacher.getCurrentSession(), null);
  const d = await teacher.startSession({ scenario_id: SEED_IDS.gabriel });
  S.SessionDetail.strict().parse(d); assert.deepEqual(leaks(d), []);
  assert.deepEqual(d.turns.map(t => [t.seq, t.speaker, t.text]), [[1, 'student', ko.greet]]);
  const dup = await rejects(teacher.startSession({ scenario_id: SEED_IDS.gabriel }), 'session_active', 409);
  assert.equal((dup.body.error.details as { session_id: string }).session_id, d.session.id);
  assert.equal((await teacher.getCurrentSession())!.session.id, d.session.id);
  await rejects(teacher.sendTurn(d.session.id, { text: '  ' }), 'validation_failed');                   // 스트림 시작 전 오류 = 첫 next() 에서 throw
  await rejects(teacher.getSession('00000000-0000-4000-8000-999999999999'), 'not_found', 404);

  // 턴 SSE: runTurn 이벤트가 SseEvent 유니온으로, done 에 이번 턴 발화(seq 포함)
  const play = async (text: string) => { const evs: SseEvent[] = []; for await (const ev of teacher.sendTurn(d.session.id, { text })) { S.SseEvent.parse(ev); assert.deepEqual(leaks(ev), []); evs.push(ev); } return evs; };
  const t1 = await play('어떻게 풀었는지 말해 줄래?');
  assert.deepEqual(t1.map(e => e.type), ['classification', 'student', 'done']);
  assert.equal((t1[0] as { leverage: string }).leverage, 'Eliciting');
  assert.deepEqual(t1[1], { type: 'student', text: ko.elicit[0], final: true });
  const done1 = t1[2] as Extract<SseEvent, { type: 'done'; ended: false }>;
  assert.deepEqual(done1.turns.map(t => [t.seq, t.speaker, t.leverage, t.trigger]), [[2, 'teacher', 'Eliciting', null], [3, 'student', null, null]]);
  for (const q of ['한 친구가 받는 걸 모두 합치면 얼마야?', '그러면 한 사람이 받는 게 전부 얼마인지 하나로 말해 볼래?', '4분의 1 조각을 반으로 자르면 어떻게 될까?', '그러면 2/4는 8분의 1 조각 몇 개랑 같아?', '8분의 1 조각이 다 해서 몇 개야?']) await play(q);
  const reach = await play('세어 보면 몇 개야?');
  assert.deepEqual(reach.map(e => e.type), ['classification', 'student', 'trigger', 'mentor', 'done']);
  assert.deepEqual(reach[2], { type: 'trigger', trigger: 3 });
  assert.deepEqual(reach[3], { type: 'mentor', text: ko.t3, final: true });
  const doneR = reach[4] as Extract<SseEvent, { type: 'done'; ended: false }>;
  assert.deepEqual(doneR.turns.map(t => [t.speaker, t.trigger]), [['teacher', null], ['student', null], ['mentor', 3]]);   // trigger 는 멘토 행에만(티켓 11)
  const after = await teacher.getSession(d.session.id);
  assert.equal(after.session.goal_reached, true); assert.equal(after.turns.length, 1 + 7 * 2 + 1); assert.equal(after.report, null);

  // 종료: END SESSION 발화 == endSession, 리포트 1회 저장, current 는 null
  const report = await teacher.endSession(d.session.id);
  assert.ok(report); S.SessionReport.strict().parse(report);
  assert.equal(report.verdict, 'clean'); assert.equal(report.reached, true); assert.equal(report.total, 7);
  assert.deepEqual(report.rows.map(r => [r.name, r.count, r.turns.length]), [['Eliciting', 6, 6], ['Extending', 1, 1], ['Taking Over', 0, 0], ['Other', 0, 0]]);
  assert.match(report.summary!, /도달/);
  assert.equal(await teacher.getCurrentSession(), null);
  await rejects(teacher.sendTurn(d.session.id, { text: '안녕' }), 'session_ended', 409);
  assert.deepEqual((await teacher.getSession(d.session.id)).report, report);                            // 재열람 = 저장본
  const mine = await teacher.listSessions(); assert.equal(mine.length, 1); assert.deepEqual(leaks(mine), []); S.SessionRow.strict().parse(mine[0]);

  // 관리자 기록·CSV·대화 테스트(초안 허용)
  assert.equal((await admin.listAdminSessions({ user_id: SEED_IDS.u(1) })).length, 1);
  assert.equal((await admin.listAdminSessions({ user_id: SEED_IDS.u(2) })).length, 0);
  const csvBytes = new Uint8Array(await (await admin.downloadSessionsCsv({})).arrayBuffer()), csv = new TextDecoder().decode(csvBytes);
  assert.deepEqual([...csvBytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);                                      // BOM 보존
  assert.ok(csv.startsWith('session_id,started_at,nickname,scenario,lang,seq,speaker,text,leverage,object,trigger'));
  assert.equal(csv.split('\r\n').length, 1 + 16);
  const sc = await admin.getScenario(SEED_IDS.gabriel);
  assert.ok('internal' in sc && !('compiled_prompt' in sc));
  await rejects(admin.deleteScenario(SEED_IDS.gabriel), 'scenario_has_sessions', 409);
  const { id: _i, slug: _s, status: _st, created_at: _c, updated_at: _u, groups: _g, session_count: _n, ...input } = sc;
  const saved = await admin.updateScenario(SEED_IDS.gabriel, input);
  assert.equal(saved.status, 'draft');                                                                  // PUT 은 항상 draft
  assert.equal((await teacher.getPractice()).scenarios.length, 0);                                       // 초안은 예비교사에게 안 보임
  await rejects(teacher.startSession({ scenario_id: SEED_IDS.gabriel }), 'forbidden', 403);
  const test = await admin.startSession({ scenario_id: SEED_IDS.gabriel });                             // 관리자 대화 테스트: 같은 경로, 초안 허용
  assert.equal(test.session.user_id, SEED_IDS.admin);
  await admin.endSession(test.session.id);
  const review = await admin.reviewScenario(SEED_IDS.gabriel);
  assert.equal(review.publishable, true);
  await rejects(admin.publishScenario(SEED_IDS.gabriel, { confirmed: ['m1'] }), 'review_failed', 422);
  assert.equal((await admin.publishScenario(SEED_IDS.gabriel, { confirmed: ['m1', 'm2', 'm3', 'm4'] })).status, 'published');
  const created = await admin.createScenario({ ...input, translations: { ...input.translations, ko: { ...input.translations.ko, name: '새 학생' } } });
  assert.equal(created.status, 'draft'); assert.equal((await admin.listScenarios()).length, 2);
  await admin.deleteScenario(created.id);
  assert.deepEqual(S.Compiled.parse(await admin.getScenarioPrompt(SEED_IDS.gabriel)), { student: '<student gabriel>', analysis: '<analysis gabriel>', mentor: '<mentor gabriel>' });

  // 사용자·그룹
  const users = await admin.listUsers(); assert.equal(users.length, 7); assert.deepEqual(leaks(users), []);
  assert.deepEqual(users.find(u => u.id === SEED_IDS.u(1))!.session_count, 1);
  await admin.resetUserPassword(SEED_IDS.u(1), { password: 'newpw123' });
  await rejects(teacher.me(), 'unauthorized');                                                          // 재설정 = 그 사용자의 로그인 종료
  await teacher.login({ nickname: '하늘쌤', password: 'newpw123' });
  const g = await admin.createGroup({ name: '새 반', member_ids: [SEED_IDS.u(7)], scenario_ids: [SEED_IDS.gabriel] });
  assert.equal(g.members[0].nickname, '민트초코'); assert.equal(g.scenarios[0].name, '가브리엘');
  await admin.deleteGroup(g.id); assert.equal((await admin.listGroups()).length, 4);
  await admin.deleteUser(SEED_IDS.u(1));
  assert.equal((await admin.listAdminSessions({ user_id: SEED_IDS.u(1) })).length, 0);                   // cascade
  assert.equal((await admin.getAiSettings()).student.key_source, 'own');

  // 6) 저장·복원: 같은 storage 로 새 Store 를 열면 같은 상태
  assert.ok(storage.getItem(STORAGE_KEY));
  const again = new Store(storage, () => { throw new Error('must not reseed'); });
  assert.equal(again.db.sessions.length, store.db.sessions.length); assert.equal(again.db.users.length, 7);  // admin + 7 - 삭제 1
}
// 턴 상한·시드 재생(별도 저장소)
{
  const st = new Store(memoryStorage(), () => seedDb());
  const api = createMockApi({ realm: 'teacher', store: st, now, turnLimit: 1 });
  st.db.login.teacher = SEED_IDS.u(2);
  const s = await api.startSession({ scenario_id: SEED_IDS.gabriel });
  for await (const _ of api.sendTurn(s.session.id, { text: '안녕' })) { /* */ }
  await rejects(api.sendTurn(s.session.id, { text: '안녕' }), 'turn_limit_reached', 422);
  const st2 = new Store(memoryStorage(), () => seedDb());
  await seedSessions(st2); await seedSessions(st2);
  assert.equal(st2.db.sessions.length, 3); assert.ok(st2.db.sessions.every(s => s.ended_at && s.report));
  assert.deepEqual(st2.db.sessions.map(s => s.report!.verdict), ['clean', 'heavy', 'mixed']);
  assert.equal(st2.db.login.teacher, null);
}

// 4) 교체 지점
{
  assert.equal(typeof createApi('teacher', { VITE_MOCK_API: '1' }).sendTurn, 'function');
  const http = createApi('teacher', {});
  assert.notEqual(http, createApi('teacher', { VITE_MOCK_API: '1' }));
}

// 5) HTTP 구현: 라우트 표에서 생성된 메서드가 바른 요청을 만들고 SSE 를 파싱한다
{
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (status: number, body: string, type = 'application/json') => new Response(body, { status, headers: { 'content-type': type } });
  const fetchStub = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/turns')) return reply(200, 'event: classification\ndata: {"leverage":"Eliciting","object":null}\n\nevent: student\ndata: {"text":"음","final":false}\n\nevent: student\ndata: {"text":"음… 저","final":true}\n\n: comment\n\nevent: done\ndata: {"ended":false,"turns":[]}\n\n', 'text/event-stream');
    if (url.includes('/api/sessions/current')) return reply(200, 'null');
    if (url.includes('/api/admin/scenarios/')) return reply(404, JSON.stringify({ error: { code: 'not_found', message: 'no' } }));
    if (url.endsWith('.csv?user_id=u1')) return reply(200, '﻿session_id', 'text/csv');
    if (url.endsWith('/logout')) return new Response(null, { status: 204 });
    return reply(200, '{}');
  }) as unknown as typeof fetch;
  const api = createHttpApi({ realm: 'admin', fetch: fetchStub, base: 'http://x' });
  await api.startSession({ scenario_id: 'a' });
  assert.equal(calls[0].url, 'http://x/api/sessions'); assert.equal(calls[0].init.method, 'POST');
  assert.equal((calls[0].init.headers as Record<string, string>)['x-remath-realm'], 'admin'); assert.equal(calls[0].init.body, '{"scenario_id":"a"}');
  assert.equal((calls[0].init.headers as Record<string, string>)['content-type'], 'application/json');
  assert.equal(await api.getCurrentSession(), null);
  await rejects(api.getScenario('abc'), 'not_found', 404); assert.equal(calls.at(-1)!.url, 'http://x/api/admin/scenarios/abc');
  assert.deepEqual([...new Uint8Array(await (await api.downloadSessionsCsv({ user_id: 'u1' })).arrayBuffer())].slice(0, 3), [0xef, 0xbb, 0xbf]);
  assert.equal(await api.logout(), undefined);
  assert.equal((calls.at(-1)!.init.headers as Record<string, string>)['x-remath-realm'], undefined);  // teacher 전용 라우트엔 realm 헤더 없음
  const evs: SseEvent[] = []; for await (const ev of api.sendTurn('s1', { text: 'hi' })) evs.push(ev);
  assert.deepEqual(evs, [{ type: 'classification', leverage: 'Eliciting', object: null }, { type: 'student', text: '음', final: false }, { type: 'student', text: '음… 저', final: true }, { type: 'done', ended: false, turns: [] }]);
  assert.equal(calls.at(-1)!.init.headers && (calls.at(-1)!.init.headers as Record<string, string>).accept, 'text/event-stream');
  // 조각난 프레임도 이어 붙인다
  const chunks = ['event: student\nda', 'ta: {"text":"a","final":true}\n', '\nevent: done\ndata: {"ended":true,"report":null}\n\n'];
  const body = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); } });
  const got: SseEvent[] = []; for await (const ev of sse(Promise.resolve(new Response(body)))) got.push(ev);
  assert.deepEqual(got.map(e => e.type), ['student', 'done']);
}

console.log(`OK — ${Object.keys(API_ROUTES).length} methods ↔ ${routes.length} routes, mock exposes no internal keys, HTTP + SSE parser OK`);
