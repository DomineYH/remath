// 목 구현 — 서버 핸들러를 브라우저 안에서 흉내 낸다. 턴은 공유 패키지의 runTurn + mockProvider 를 **그대로** 돌린다(LLM 흉내를 따로 두지 않는다).
// 규칙(409 session_active·turn_in_progress, PUT→draft, 삭제 409, 인사 seq 1, 턴 상한 40)은 SPEC 3·4절과 같다. 서버가 생기면 이 파일만 버린다.
import type { z } from 'zod';
import { routes } from '../../../../api-contract/src/routes.ts';
import * as S from '../../../../api-contract/src/schemas.ts';
import type { Criteria } from '../../../../llm-adapter/src/adapter.ts';
import { reportInput, type SessionState } from '../../../../llm-adapter/src/engine.ts';
import { mockProvider } from '../../../../llm-adapter/src/mock/provider.ts';
import { runTurn, type Turn as PipeTurn } from '../../../../llm-adapter/src/pipeline.ts';
import { API_ROUTES, ApiError, type Api, type ClientRealm, type SseEvent } from '../types.ts';
import { memoryStorage, SEED_IDS, seedDb, Store, type Db, type ScenarioRow, type SessionRow, type Storage, type UserRow } from './store.ts';

type Compiled = z.infer<typeof S.Compiled>;
export interface MockOptions {
  realm: ClientRealm;
  store?: Store;                                   // 한 페이지의 teacher/admin 두 인스턴스는 같은 store 를 공유한다
  storage?: Storage;
  compile?: (s: ScenarioRow, lang: 'ko' | 'en') => Compiled;  // prompts/ 의 compileScenario. 목은 내용을 읽지 않으므로 기본은 표식 문자열
  now?: () => string;
  turnLimit?: number;
}
const STATUS: Record<string, number> = { validation_failed: 400, unauthorized: 401, invalid_credentials: 401, forbidden: 403, not_found: 404, nickname_taken: 409, session_active: 409, session_ended: 409, turn_in_progress: 409, scenario_has_sessions: 409, review_failed: 422, turn_limit_reached: 422 };
const fail = (code: string, message = code, details?: unknown): never => { throw new ApiError(STATUS[code] ?? 500, { error: { code, message, details } }); };
const stubCompile = (s: ScenarioRow): Compiled => ({ student: `<student ${s.slug}>`, analysis: s.classification.leverage.length ? `<analysis ${s.slug}>` : null, mentor: `<mentor ${s.slug}>` });

let shared: Store | undefined;
export function createMockApi(o: MockOptions): Api {
  const store = o.store ?? (shared ??= new Store(o.storage ?? (globalThis as { localStorage?: Storage }).localStorage ?? memoryStorage(), () => seedDb()));
  const db = store.db, now = o.now ?? (() => new Date().toISOString()), compile = o.compile ?? stubCompile, turnLimit = o.turnLimit ?? 40;
  const save = () => store.save();
  const uuid = () => crypto.randomUUID();

  // ---- 로그인·접근 ------------------------------------------------------------
  const who = (realm: ClientRealm): UserRow => db.users.find(u => u.id === db.login[realm]) ?? fail('unauthorized');
  const loginAs = (realm: ClientRealm, c: z.infer<typeof S.Credentials>) => {
    const u = db.users.find(u => u.role === (realm === 'admin' ? 'admin' : 'teacher') && u.nickname.toLowerCase() === c.nickname.toLowerCase());
    if (!u || u.password !== c.password) fail('invalid_credentials'); // ponytail: 5회 지연(429) 은 흉내 내지 않는다
    db.login[realm] = u!.id; save(); return me(u!);
  };
  const me = (u: UserRow) => ({ id: u.id, nickname: u.nickname, role: u.role, pw_updated_at: u.pw_updated_at });
  const changePw = (u: UserRow, b: z.infer<typeof S.PasswordChange>) => { if (u.password !== b.current) fail('invalid_credentials'); u.password = b.next; u.pw_updated_at = now(); save(); };
  const groupsOf = (pred: (g: Db['groups'][number]) => boolean) => db.groups.filter(pred).map(g => ({ id: g.id, name: g.name }));
  const visibleTo = (u: UserRow) => u.role === 'admin' ? db.scenarios : db.scenarios.filter(s => s.status === 'published' && db.groups.some(g => g.member_ids.includes(u.id) && g.scenario_ids.includes(s.id)));

  // ---- 시나리오 투영: 예비교사용은 scenarios_public 뷰 열만(internal·compiled_prompt 없음) --------------
  const tr = (s: ScenarioRow) => s.translations[s.lang];
  const toPublic = (s: ScenarioRow) => { const t = tr(s); return { id: s.id, slug: s.slug, status: 'published' as const, lang: s.lang, student_prefix: s.student_prefix, mentor_prefix: s.mentor_prefix, grade: s.grade, classification: s.classification, name: t.name, description: t.description, problem: t.problem, chars: t.chars, greet: t.greet, elicit: t.elicit, created_at: s.created_at, updated_at: s.updated_at }; };
  const sessionCount = (sid: string) => db.sessions.filter(x => x.scenario_id === sid).length;
  const toAdmin = (s: ScenarioRow) => { const { compiled_prompt: _, ...row } = s; return { ...row, groups: groupsOf(g => g.scenario_ids.includes(s.id)), session_count: sessionCount(s.id) }; };
  const toSummary = (s: ScenarioRow) => ({ id: s.id, slug: s.slug, status: s.status, lang: s.lang, student_prefix: s.student_prefix, grade: s.grade, name: tr(s).name, problem: tr(s).problem, classification_count: { leverage: s.classification.leverage.length, object: s.classification.object.length }, groups: groupsOf(g => g.scenario_ids.includes(s.id)), session_count: sessionCount(s.id), updated_at: s.updated_at });
  const scenarioById = (id: string) => db.scenarios.find(s => s.id === id) ?? fail('not_found');
  const slugOf = (s: z.infer<typeof S.ScenarioInput>) => (s.translations.en.name || s.translations.ko.name || 'scenario').toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '') || 'scenario';
  /** 목업 autoChecks 이식(c1~c6) + c7 두 판 구조 일치(티켓 9). 저장소에서는 shared/ 순수 함수로 서버와 공용. */
  const review = (s: ScenarioRow): z.infer<typeof S.ReviewResult> => {
    const t = tr(s), i = s.internal, cls = s.classification, on = cls.leverage.length > 0;
    const st = (ok: boolean) => (ok ? 'pass' : 'fail') as 'pass' | 'fail';
    const auto = [
      { id: 'c1' as const, status: st(!!(t.name && t.problem && i.baseline && i.reasoning && i.goal)) },
      { id: 'c2' as const, status: st(t.misconceptions.length > 0 && t.misconceptions.every(m => m.kw && m.h && m.c)) },
      { id: 'c3' as const, status: st(!!(t.t1 && t.t2 && t.t3)) },
      { id: 'c4' as const, status: st(!!(i.never && t.confused.length)) },
      { id: 'c5' as const, status: st(!/통분하면|공식은|알고리즘은|최소공배수|common denominator|least common multiple|the algorithm/i.test([t.aha, ...t.misconceptions.map(m => m.c)].join(' '))) },
      { id: 'c6' as const, status: on ? st([...cls.leverage, ...cls.object].every(r => r.desc && r.ex)) : 'info' as const },
      { id: 'c7' as const, status: st(['ko', 'en'].every(l => { try { compile(s, l as 'ko' | 'en'); return true; } catch { return false; } })) },
    ];
    return { auto, publishable: auto.every(a => a.status !== 'fail') };
  };

  // ---- 연습 세션 -------------------------------------------------------------
  const sessionOf = (u: UserRow, id: string): SessionRow => { const s = db.sessions.find(s => s.id === id) ?? fail('not_found'); if (s.user_id !== u.id && u.role !== 'admin') fail('forbidden'); return s; };
  const turnsOf = (sid: string) => db.turns.filter(t => t.session_id === sid).sort((a, b) => a.seq - b.seq);
  const sessionRow = (s: SessionRow): z.infer<typeof S.SessionRow> => { const sc = db.scenarios.find(x => x.id === s.scenario_id)!, u = db.users.find(x => x.id === s.user_id)!; return { id: s.id, scenario_id: s.scenario_id, scenario_name: sc.translations[s.lang].name, lang: s.lang, user_id: s.user_id, nickname: u.nickname, started_at: s.started_at, ended_at: s.ended_at, goal_reached: s.progress.goalReached, turn_count: turnsOf(s.id).length }; };
  const detail = (s: SessionRow): z.infer<typeof S.SessionDetail> => ({ session: sessionRow(s), turns: turnsOf(s.id).map(({ session_id: _, ...t }) => t), report: s.report });
  const current = (u: UserRow) => db.sessions.find(s => s.user_id === u.id && !s.ended_at);
  const addTurn = (s: SessionRow, t: Omit<PipeTurn, 'speaker'> & { speaker: PipeTurn['speaker']; leverage?: string | null; object?: string | null; trigger?: 1 | 2 | 3 | null }) => {
    const row = { session_id: s.id, seq: turnsOf(s.id).length + 1, speaker: t.speaker, text: t.text, leverage: t.leverage ?? null, object: t.object ?? null, trigger: t.trigger ?? null, created_at: now() };
    db.turns.push(row); const { session_id: _, ...out } = row; return out;
  };
  const start = (u: UserRow, scenario_id: string) => {
    const sc = db.scenarios.find(s => s.id === scenario_id) ?? fail('not_found');
    if (!visibleTo(u).includes(sc)) fail('forbidden');
    const active = current(u); if (active) fail('session_active', 'a session is in progress', { session_id: active.id });
    const s: SessionRow = { id: uuid(), user_id: u.id, scenario_id, lang: sc.lang, started_at: now(), ended_at: null, turn_started_at: null, report: null, progress: { mis: sc.internal.misconceptions.map(() => 0), counts: {}, goalReached: false, takeOverCount: 0 } };
    db.sessions.push(s); addTurn(s, { speaker: 'student', text: tr(sc).greet }); save(); return s;
  };
  /** 한 턴: runTurn 이벤트 → SSE 이벤트. 서버의 SSE 핸들러와 같은 변환·같은 기록 규칙(error 면 이 턴 발화 미기록). */
  async function* turn(s: SessionRow, text: string): AsyncGenerator<SseEvent> {
    if (s.ended_at) fail('session_ended');
    if (s.turn_started_at) fail('turn_in_progress', 'turn in progress', { turn_started_at: s.turn_started_at });
    const history = turnsOf(s.id);
    if (history.filter(t => t.speaker === 'teacher').length >= turnLimit) fail('turn_limit_reached');
    const sc = db.scenarios.find(x => x.id === s.scenario_id)!, t = sc.translations[s.lang];
    const criteria: Criteria | null = sc.classification.leverage.length ? sc.classification : null;
    s.turn_started_at = now(); save();
    const bots = { student: mockProvider, analysis: mockProvider, mentor: mockProvider, model: 'mock' };
    const pending: Parameters<typeof addTurn>[1][] = [{ speaker: 'teacher', text }];
    try {
      for await (const ev of runTurn({ bots, compiled: sc.compiled_prompt ?? compile(sc, s.lang), criteria, tr: t, lang: s.lang, state: s.progress, history: history.map(h => ({ speaker: h.speaker, text: h.text })), text })) {
        if (ev.type === 'classification') { if (ev.cls) { Object.assign(pending[0], ev.cls); yield { type: 'classification', ...ev.cls }; } }
        else if (ev.type === 'student') { pending.push({ speaker: 'student', text: ev.text }); yield { type: 'student', text: ev.text, final: true }; }
        else if (ev.type === 'trigger') { pending.push({ speaker: 'mentor', text: '', trigger: ev.trigger }); yield ev; }
        else if (ev.type === 'mentor') { pending[pending.length - 1].text = ev.text; yield { type: 'mentor', text: ev.text, final: true }; }
        else if (ev.ended) {
          s.ended_at = now(); s.progress = ev.state;
          s.report = criteria ? report(criteria, history, ev.state, ev.summary ?? null) : null;
          yield { type: 'done', ended: true, report: s.report };
        } else { s.progress = ev.state; yield { type: 'done', ended: false, turns: pending.map(p => addTurn(s, p)) }; }
      }
    } catch (e) {
      yield { type: 'error', code: 'provider_unavailable', message: String((e as Error).message), retryable: true };
    } finally { s.turn_started_at = null; save(); }
  }
  /** 티켓 14: 서버가 레버리지 카운트로 판정·목록을 만들고 분석 챗봇 문장은 summary 로만. */
  const report = (criteria: Criteria, history: ReturnType<typeof turnsOf>, state: SessionState, summary: string | null): z.infer<typeof S.SessionReport> => {
    const teacher = history.filter(t => t.speaker === 'teacher');
    const r = reportInput(criteria.leverage.map(x => x.name), state.counts, state.goalReached);
    return { total: teacher.length, reached: r.reached, verdict: r.verdict, rows: criteria.leverage.map(x => ({ name: x.name, desc: x.desc ?? '', count: state.counts[x.name] ?? 0, turns: teacher.filter(t => t.leverage === x.name).map(t => ({ seq: t.seq, text: t.text })) })), summary };
  };
  const end = async (s: SessionRow) => { let rep: z.infer<typeof S.SessionReport> | null = null; for await (const ev of turn(s, 'END SESSION')) if (ev.type === 'done' && ev.ended) rep = ev.report; else if (ev.type === 'error') fail('provider_unavailable', ev.message); return rep; };

  // ---- 관리자: 사용자·그룹·기록 -------------------------------------------------
  const userRow = (u: UserRow): z.infer<typeof S.UserRow> => { const gs = db.groups.filter(g => g.member_ids.includes(u.id)); return { id: u.id, nickname: u.nickname, groups: gs.map(g => ({ id: g.id, name: g.name })), scenario_count: new Set(gs.flatMap(g => g.scenario_ids)).size, session_count: db.sessions.filter(s => s.user_id === u.id).length, created_at: u.created_at, pw_updated_at: u.pw_updated_at }; };
  const userById = (id: string) => db.users.find(u => u.id === id && u.role === 'teacher') ?? fail('not_found');
  const groupOut = (g: Db['groups'][number]): z.infer<typeof S.Group> => ({ id: g.id, name: g.name, members: g.member_ids.map(id => ({ id, nickname: db.users.find(u => u.id === id)?.nickname ?? '?' })), scenarios: g.scenario_ids.map(id => { const s = scenarioById(id); return { id, name: tr(s).name, lang: s.lang, status: s.status }; }) });
  const groupById = (id: string) => db.groups.find(g => g.id === id) ?? fail('not_found');
  const filtered = (q: z.infer<typeof S.SessionFilter>) => db.sessions.filter(s => (!q.user_id || s.user_id === q.user_id) && (!q.scenario_id || s.scenario_id === q.scenario_id)).sort((a, b) => b.started_at.localeCompare(a.started_at));
  const csv = (rows: SessionRow[]) => { // C13: 1행 = 1발화, UTF-8 BOM
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.flatMap(s => { const r = sessionRow(s); return turnsOf(s.id).map(t => [s.id, s.started_at, r.nickname, r.scenario_name, s.lang, t.seq, t.speaker, t.text, t.leverage, t.object, t.trigger].map(q).join(',')); });
    return '﻿' + ['session_id,started_at,nickname,scenario,lang,seq,speaker,text,leverage,object,trigger', ...lines].join('\r\n');
  };

  const impl: Api = {
    signup: async b => { if (db.users.some(u => u.nickname.toLowerCase() === b.nickname.toLowerCase())) fail('nickname_taken'); const t = now(); db.users.push({ id: uuid(), nickname: b.nickname, password: b.password, role: 'teacher', created_at: t, pw_updated_at: t }); return loginAs('teacher', b); },
    login: async b => loginAs('teacher', b), logout: async () => { db.login.teacher = null; save(); }, me: async () => me(who('teacher')), changePassword: async b => changePw(who('teacher'), b),
    adminLogin: async b => loginAs('admin', b), adminLogout: async () => { db.login.admin = null; save(); }, adminMe: async () => me(who('admin')), adminChangePassword: async b => changePw(who('admin'), b),

    getPractice: async () => { const u = who('teacher'); return { groups: groupsOf(g => g.member_ids.includes(u.id)), scenarios: visibleTo(u).map(s => ({ ...toPublic(s), group_ids: db.groups.filter(g => g.member_ids.includes(u.id) && g.scenario_ids.includes(s.id)).map(g => g.id) })) }; },
    listSessions: async () => { const u = who('teacher'); return filtered({ user_id: u.id }).map(sessionRow); },
    getCurrentSession: async () => { const s = current(who(o.realm)); return s ? detail(s) : null; },
    startSession: async b => detail(start(who(o.realm), b.scenario_id)),
    getSession: async id => detail(sessionOf(who(o.realm), id)),
    sendTurn: async function* (id, b) { yield* turn(sessionOf(who(o.realm), id), b.text); }, // 시작 전 오류도 첫 next() 에서 throw
    endSession: async id => end(sessionOf(who(o.realm), id)),

    listScenarios: async () => { who('admin'); return [...db.scenarios].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(toSummary); },
    createScenario: async b => { who('admin'); const t = now(); const s: ScenarioRow = { ...b, id: uuid(), slug: slugOf(b), status: 'draft', compiled_prompt: null, created_at: t, updated_at: t }; db.scenarios.push(s); save(); return toAdmin(s); },
    getScenario: async id => { who('admin'); return toAdmin(scenarioById(id)); },
    updateScenario: async (id, b) => { who('admin'); const s = scenarioById(id); Object.assign(s, b, { status: 'draft', compiled_prompt: null, updated_at: now() }); save(); return toAdmin(s); },
    deleteScenario: async id => { who('admin'); const s = scenarioById(id); const n = sessionCount(id); if (n) fail('scenario_has_sessions', 'scenario has sessions', { session_count: n }); db.scenarios.splice(db.scenarios.indexOf(s), 1); for (const g of db.groups) g.scenario_ids = g.scenario_ids.filter(x => x !== id); save(); },
    reviewScenario: async id => { who('admin'); return review(scenarioById(id)); },
    publishScenario: async (id, b) => { who('admin'); const s = scenarioById(id), r = review(s); if (!r.publishable || b.confirmed.length < 4) fail('review_failed', 'review failed', r); s.compiled_prompt = compile(s, s.lang); s.status = 'published'; s.updated_at = now(); save(); return toAdmin(s); },
    getScenarioPrompt: async id => { who('admin'); const s = scenarioById(id); return compile(s, s.lang); },

    listUsers: async () => { who('admin'); return db.users.filter(u => u.role === 'teacher').map(userRow); },
    createUser: async b => { who('admin'); if (db.users.some(u => u.nickname.toLowerCase() === b.nickname.toLowerCase())) fail('nickname_taken'); const t = now(), u: UserRow = { id: uuid(), nickname: b.nickname, password: b.password, role: 'teacher', created_at: t, pw_updated_at: t }; db.users.push(u); save(); return userRow(u); },
    resetUserPassword: async (id, b) => { who('admin'); const u = userById(id); u.password = b.password; u.pw_updated_at = now(); if (db.login.teacher === id) db.login.teacher = null; save(); },
    deleteUser: async id => { who('admin'); const u = userById(id); db.users.splice(db.users.indexOf(u), 1); const sids = new Set(db.sessions.filter(s => s.user_id === id).map(s => s.id)); db.sessions = db.sessions.filter(s => !sids.has(s.id)); db.turns = db.turns.filter(t => !sids.has(t.session_id)); for (const g of db.groups) g.member_ids = g.member_ids.filter(x => x !== id); if (db.login.teacher === id) db.login.teacher = null; save(); },
    listGroups: async () => { who('admin'); return db.groups.map(groupOut); },
    createGroup: async b => { who('admin'); const g = { id: uuid(), name: b.name, member_ids: b.member_ids, scenario_ids: b.scenario_ids }; db.groups.push(g); save(); return groupOut(g); },
    updateGroup: async (id, b) => { who('admin'); const g = groupById(id); Object.assign(g, { name: b.name, member_ids: b.member_ids, scenario_ids: b.scenario_ids }); save(); return groupOut(g); },
    deleteGroup: async id => { who('admin'); const g = groupById(id); db.groups.splice(db.groups.indexOf(g), 1); save(); },

    listAdminSessions: async q => { who('admin'); return filtered(q).map(sessionRow); },
    getAdminSession: async id => { who('admin'); return detail(db.sessions.find(s => s.id === id) ?? fail('not_found')); },
    downloadSessionsCsv: async q => { who('admin'); return new Blob([csv(filtered(q))], { type: 'text/csv;charset=utf-8' }); },
    getAiSettings: async () => { who('admin'); return db.ai; },
    updateAiRole: async (role, b) => { who('admin'); const cur = db.ai[role]; Object.assign(cur, { key_source: b.key_source, model: b.model, effort: b.effort }, b.api_key ? { provider: 'openai' as const, key_masked: `…${b.api_key.slice(-4)}`, key_added_at: now() } : {}); save(); return cur; }, // ponytail: 공급자 판별·키 검증은 3단계
  };

  // 본문·쿼리는 라우트 표의 zod 스키마로 검증한다(서버와 같은 400 validation_failed). 메서드마다 다시 쓰지 않도록 여기서 한 번 감싼다.
  for (const [name, key] of Object.entries(API_ROUTES) as [keyof Api, string][]) {
    const [method, path] = key.split(' '), route = routes.find(r => r.method === method && r.path === path)!, schema = route.body ?? route.query, hasParam = path.includes(':');
    const fn = impl[name] as (...a: unknown[]) => unknown;
    if (schema) (impl as Record<string, unknown>)[name] = (...a: unknown[]) => { const i = hasParam ? 1 : 0, r = schema.safeParse(a[i]); if (!r.success) return rejected(r.error.issues, route.response === 'sse'); a[i] = r.data; return fn(...a); };
  }
  return impl;
}
const rejected = (issues: unknown, isSse: boolean) => { const e = () => fail('validation_failed', 'validation failed', issues); return isSse ? (async function* () { e(); })() : Promise.reject(tryErr(e)); };
const tryErr = (f: () => never) => { try { f(); } catch (e) { return e; } };

/** 앱 시작 시 기록이 비어 있으면 한 번: 목업 SEED_LOGS 중 가브리엘 세 건(L1 도달·L2 주도권 빼앗기·L7)을 재생한다. */
export async function seedSessions(store: Store) {
  if (store.db.sessions.length) return;
  const L = [[SEED_IDS.u(1), ['안녕, 네 이름이 뭐야?', '어떻게 풀었는지 말해 줄래?', '한 친구가 받는 걸 모두 합치면 얼마야?', '그러면 한 사람이 받는 게 전부 얼마인지 하나로 말해 볼래?', '4분의 1 조각을 반으로 자르면 어떻게 될까?', '그러면 2/4는 8분의 1 조각 몇 개랑 같아?', '8분의 1 조각이 다 해서 몇 개야?', '세어 보면 몇 개야?', 'END SESSION']],
    [SEED_IDS.u(2), ['안녕!', '통분하면 돼. 분모를 같게 만들어 봐.', '2/4는 4/8이니까 더하면 5/8이야. 답은 5/8이야.', '그림을 어떻게 그렸어?', 'END SESSION']],
    [SEED_IDS.u(5), ['어떻게 풀었는지 말해 줄래?', '분모를 같게 통분해 봐.', '4분의 1 조각을 반으로 자르면 어떻게 될까?', 'END SESSION']]] as const;
  for (const [u, qs] of L) await playSession(store, 'teacher', u, SEED_IDS.gabriel, [...qs]);
}

/** 시드용: 목업 SEED_LOGS 처럼 질문 목록을 같은 파이프라인으로 재생해 기록을 만든다. */
export async function playSession(store: Store, realm: ClientRealm, user_id: string, scenario_id: string, questions: string[], now?: () => string) {
  const api = createMockApi({ realm, store, now });
  const prevLogin = store.db.login[realm]; store.db.login[realm] = user_id;
  try {
    const s = await api.startSession({ scenario_id });
    for (const q of questions) for await (const _ of api.sendTurn(s.session.id, { text: q })) { /* 소비만 */ }
    return s.session.id;
  } finally { store.db.login[realm] = prevLogin; store.save(); }
}
