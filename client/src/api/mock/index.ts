// 목 구현 — 서버 핸들러를 브라우저 안에서 흉내 낸다. 1차(#22): 인증 9개·저장소·감사 helper와 빈 목록들. 나머지는 #23~#27 이 채운다.
// 규칙(400 검증·409 중복·401 구분 없음·비밀번호 변경 = 다른 로그인 종료·세션 409/422)은 서버와 같다. 턴은 공유 runTurn + mockProvider 를 그대로 돌린다(#24). 서버가 생기면 이 폴더만 버린다.
import { compileScenario, TEMPLATES } from '@remath/prompts';
import { ERROR_STATUS, routes, type ErrorCode } from '@remath/shared';
import providers from '@remath/shared/providers.json';
import * as S from '@remath/shared';
import { END_SESSION_RE, mockProvider, runTurn, sessionReport, type SessionState } from '@remath/shared/engine';
import type { z } from 'zod';
import { API_ROUTES, ApiError, type AdminSseEvent, type Api, type ClientRealm } from '../types.ts';
import { audit } from './audit.ts';
import { hashPassword, verifyPassword } from './crypto.ts';
import { memoryStorage, seedDb, Store, type Db, type ScenarioRow, type SessionRow, type Storage, type TurnRow, type UserRow } from './store.ts';

/** 목 번들에만 있는 고정 문자열. check:bundle 이 프로덕션 산출물에 이것이 없음을 확인한다(A-4). */
export const MOCK_MARKER = 'remath-mock-api::do-not-deploy';

type Jar = { teacher: string | null; admin: string | null };
export interface MockOptions {
  realm: ClientRealm;
  store?: Store;                                   // 한 페이지의 teacher/admin 두 인스턴스는 같은 store 를 공유한다
  storage?: Storage;
  now?: () => string;
  /** 예비교사 발화 수 상한(D-15). 생략하면 40. 테스트가 작게 주입해 422 를 만든다. */
  turnLimit?: number;
  /** 관리자 초기 비밀번호. 생략하면 VITE_MOCK_ADMIN_PASSWORD. 비었으면 관리자 로그인은 늘 401(G-33). */
  adminPassword?: string;
  /** 이 브라우저의 쿠키 상자. 생략하면 저장소의 login(이 브라우저). 테스트는 따로 넘겨 같은 서버의 다른 브라우저를 흉내 낸다. */
  cookies?: Jar;
}

const fail = (code: ErrorCode, message: string = code, details?: unknown): never => { throw new ApiError(ERROR_STATUS[code], { error: { code, message, details } }); };
const todo = (name: string, issue: number) => (): never => { throw new Error(`mock: ${name} lands in #${issue}`); };

let shared: Store | undefined;
export function createMockApi(o: MockOptions): Api {
  console.warn(MOCK_MARKER);
  const now = o.now ?? (() => new Date().toISOString());
  const store = o.store ?? (shared ??= new Store(o.storage ?? (globalThis as { localStorage?: Storage }).localStorage ?? memoryStorage(), () => seedDb(now())));
  const db = store.db, jar: Jar = o.cookies ?? db.login;
  // ponytail: 환경변수는 관리자 *초기* 비밀번호일 뿐이다. adminChangePassword 뒤에는 저장된 해시를 쓴다(되돌리려면 remath.mock.v1 삭제).
  const adminPassword = 'adminPassword' in o ? o.adminPassword : import.meta.env.VITE_MOCK_ADMIN_PASSWORD;
  const save = () => store.save();
  const turnLimit = o.turnLimit ?? 40;
  const uuid = () => crypto.randomUUID();

  // ---- 로그인·접근 (쿠키 = 실별 토큰) ---------------------------------------------------
  const who = (realm: ClientRealm): UserRow => {
    const s = db.auth_sessions.find(a => a.realm === realm && a.token_hash === jar[realm]);
    return db.users.find(u => u.id === s?.user_id && u.role === realm) ?? fail('unauthorized');
  };
  const me = (u: UserRow): z.infer<typeof S.Me> => ({ id: u.id, nickname: u.nickname, role: u.role, pw_updated_at: u.pw_updated_at });
  const issue = (realm: ClientRealm, u: UserRow) => {
    const token = uuid();
    db.auth_sessions.push({ id: uuid(), user_id: u.id, realm, token_hash: token, created_at: now() });
    jar[realm] = token;
  };
  const passwordOk = async (u: UserRow, pw: string) =>
    u.password_hash ? verifyPassword(pw, u.password_hash) : !!adminPassword && u.role === 'admin' && verifyPassword(pw, await hashPassword(adminPassword));
  const loginAs = async (realm: ClientRealm, c: z.infer<typeof S.Credentials>) => {
    const u = db.users.find(u => u.role === realm && u.nickname.toLowerCase() === c.nickname.toLowerCase());
    if (!u || !(await passwordOk(u, c.password))) {   // 없는 닉네임과 틀린 비밀번호는 같은 401
      audit(db, now(), { actor_id: null, action: 'auth.login_failed', target: c.nickname, meta: { realm, reason: 'invalid_credentials' } });
      save(); return fail('invalid_credentials', 'invalid nickname or password');   // ponytail: 5회 실패 429(too_many_attempts)는 흉내 내지 않는다
    }
    issue(realm, u); save(); return me(u);
  };
  const logoutOf = (realm: ClientRealm) => {
    who(realm);
    db.auth_sessions = db.auth_sessions.filter(a => !(a.realm === realm && a.token_hash === jar[realm]));
    jar[realm] = null; save();
  };
  /** 현재 비밀번호 확인 → 해시 교체 → 이 토큰 말고 그 사용자의 로그인 모두 종료 → 감사 1행. */
  const changePw = async (realm: ClientRealm, b: z.infer<typeof S.PasswordChange>) => {
    const u = who(realm);
    if (!(await passwordOk(u, b.current))) fail('invalid_credentials', 'current password is incorrect');
    const t = now();
    u.password_hash = await hashPassword(b.next); u.pw_updated_at = t; u.updated_at = t;
    db.auth_sessions = db.auth_sessions.filter(a => a.user_id !== u.id || a.token_hash === jar[realm]);
    audit(db, t, { actor_id: u.id, action: 'auth.password_change', target: u.id, meta: { realm } });
    save();
  };

  // ---- 투영 (예비교사용은 scenarios_public 뷰 열만) ------------------------------------------
  const groupsOf = (pred: (g: Db['groups'][number]) => boolean) => db.groups.filter(pred).map(g => ({ id: g.id, name: g.name }));
  const tr = (s: ScenarioRow) => s.translations[s.lang];
  const toPublic = (s: ScenarioRow) => { const t = tr(s); return { id: s.id, slug: s.slug, status: 'published' as const, lang: s.lang, student_prefix: s.student_prefix, mentor_prefix: s.mentor_prefix, grade: s.grade, classification: s.classification, name: t.name, description: t.description, problem: t.problem, chars: t.chars, greet: t.greet, elicit: t.elicit, created_at: s.created_at, updated_at: s.updated_at }; };
  const sessionCount = (sid: string) => db.sessions.filter(x => x.scenario_id === sid).length;
  const scenario = (id: string) => db.scenarios.find(s => s.id === id) ?? fail('not_found');
  const toAdmin = ({ compiled_prompt: _, ...s }: ScenarioRow): z.infer<typeof S.ScenarioAdmin> => ({ ...s, groups: groupsOf(g => g.scenario_ids.includes(s.id)), session_count: sessionCount(s.id) });
  const toSummary = (s: ScenarioRow): z.infer<typeof S.ScenarioSummary> => ({ id: s.id, slug: s.slug, status: s.status, lang: s.lang, student_prefix: s.student_prefix, grade: s.grade, name: tr(s).name, problem: tr(s).problem, misconception_count: s.internal.misconceptions.length, classification_count: { leverage: s.classification.leverage.length, object: s.classification.object.length }, groups: groupsOf(g => g.scenario_ids.includes(s.id)), session_count: sessionCount(s.id), updated_at: s.updated_at });
  /** turn_count = 예비교사 발화 수(END SESSION 은 기록되지 않으므로 자연히 제외, D-15). */
  const sessionRow = (s: SessionRow): z.infer<typeof S.SessionRow> => {
    const sc = db.scenarios.find(x => x.id === s.scenario_id)!, u = db.users.find(x => x.id === s.user_id)!;
    return { id: s.id, scenario_id: s.scenario_id, scenario_name: sc.translations[s.lang].name, lang: s.lang, user_id: s.user_id, nickname: u.nickname, started_at: s.started_at, ended_at: s.ended_at, goal_reached: s.goal_reached, turn_count: db.turns.filter(t => t.session_id === s.id && t.speaker === 'teacher').length };
  };
  const filtered = (q: z.infer<typeof S.SessionFilter>) => db.sessions.filter(s => (!q.user_id || s.user_id === q.user_id) && (!q.scenario_id || s.scenario_id === q.scenario_id)).sort((a, b) => b.started_at.localeCompare(a.started_at));
  const userRow = (u: UserRow): z.infer<typeof S.UserRow> => { const gs = db.groups.filter(g => g.member_ids.includes(u.id)); return { id: u.id, nickname: u.nickname, groups: gs.map(g => ({ id: g.id, name: g.name })), scenario_count: new Set(gs.flatMap(g => g.scenario_ids)).size, session_count: db.sessions.filter(s => s.user_id === u.id).length, created_at: u.created_at, pw_updated_at: u.pw_updated_at }; };
  const groupOut = (g: Db['groups'][number]): z.infer<typeof S.Group> => ({ id: g.id, name: g.name, members: g.member_ids.map(id => ({ id, nickname: db.users.find(u => u.id === id)?.nickname ?? '?' })), scenarios: g.scenario_ids.flatMap(id => { const s = db.scenarios.find(x => x.id === id); return s ? [{ id, name: tr(s).name, lang: s.lang, status: s.status }] : []; }) });

  // ---- 연습 세션 (D-15·D-16·G-34) — 세션 경로는 이 인스턴스의 실(realm) 로그인으로 행동한다 ------------------
  const turnsOf = (sid: string) => db.turns.filter(t => t.session_id === sid).sort((a, b) => a.seq - b.seq);
  const detail = (s: SessionRow): z.infer<typeof S.SessionDetail> => ({ session: sessionRow(s), turns: turnsOf(s.id).map(({ session_id: _, ...t }) => t), report: s.report, turn_limit: turnLimit });
  /** 남의 세션은 있는지도 알리지 않는다(404). */
  const sessionOf = (id: string) => { const u = who(o.realm); return db.sessions.find(s => s.id === id && s.user_id === u.id) ?? fail('not_found'); };
  const current = (u: UserRow) => db.sessions.find(s => s.user_id === u.id && !s.ended_at);
  const addTurn = (s: SessionRow, t: Pick<TurnRow, 'speaker' | 'text'> & Partial<Pick<TurnRow, 'leverage' | 'object' | 'trigger'>>) => {
    const row: TurnRow = { session_id: s.id, seq: turnsOf(s.id).length + 1, speaker: t.speaker, text: t.text, leverage: t.leverage ?? null, object: t.object ?? null, trigger: t.trigger ?? null, created_at: now() };
    db.turns.push(row); const { session_id: _, ...out } = row; return out;
  };
  const start = (scenario_id: string) => {
    const u = who(o.realm), sc = scenario(scenario_id);
    const visible = u.role === 'admin' || (sc.status === 'published' && db.groups.some(g => g.member_ids.includes(u.id) && g.scenario_ids.includes(sc.id)));
    if (!visible) fail('forbidden');   // 초안·미할당은 예비교사에게 403, 관리자는 초안도 대화 테스트(G-34)
    const active = current(u);
    if (active) fail('session_active', 'a session is in progress', { session_id: active.id });
    const t = now(), s: SessionRow = { id: uuid(), user_id: u.id, scenario_id, lang: sc.lang, started_at: t, ended_at: null, goal_reached: false, counts: {}, progress: { mis: sc.internal.misconceptions.map(() => 0) }, report: null, turn_started_at: null, created_at: t, updated_at: t };
    db.sessions.push(s); addTurn(s, { speaker: 'student', text: tr(sc).greet }); save();
    return detail(s);
  };

  const lastTrigger = (s: SessionRow) => [...turnsOf(s.id)].reverse().find(t => t.trigger)?.trigger ?? null;
  const adminState = (s: SessionRow): z.infer<typeof S.AdminState> => ({ mis: s.progress.mis, counts: s.counts, goal_reached: s.goal_reached, last_trigger: lastTrigger(s) });
  const ownedByAdmin = (s: SessionRow) => db.users.find(u => u.id === s.user_id)?.role === 'admin';
  const bots = { student: mockProvider, analysis: mockProvider, mentor: mockProvider, model: 'mock' };

  /** 한 턴(G-36): runTurn 이벤트 → SSE 이벤트. 이 턴 발화는 done 에서 한꺼번에 seq 를 매겨 기록하고, error 면 하나도 기록하지 않는다.
   *  async generator 라 시작 전 오류(409·422)는 첫 next() 에서 throw 된다. */
  async function* turn(s: SessionRow, text: string): AsyncGenerator<AdminSseEvent> {
    if (s.ended_at) fail('session_ended');
    if (s.turn_started_at) fail('turn_in_progress', 'turn in progress', { turn_started_at: s.turn_started_at });
    const history = turnsOf(s.id), turn_count = history.filter(t => t.speaker === 'teacher').length;
    if (!END_SESSION_RE.test(text.trim()) && turn_count >= turnLimit) fail('turn_limit_reached', 'turn limit reached', { turn_count, turn_limit: turnLimit });   // END SESSION 은 상한 앞(D-15)
    const sc = scenario(s.scenario_id), t = sc.translations[s.lang], criteria = sc.classification.leverage.length ? sc.classification : null;
    const state: SessionState = { mis: s.progress.mis, counts: s.counts, goalReached: s.goal_reached, takeOverCount: history.filter(h => h.trigger === 1).length };
    const pending: Parameters<typeof addTurn>[1][] = [{ speaker: 'teacher', text }];
    s.turn_started_at = now(); save();
    // ponytail: TURN_TIMEOUT_MS·고아 turn_started_at 은 흉내 내지 않는다(D-15). finally 가 항상 지운다.
    try {
      for await (const ev of runTurn({ bots, compiled: sc.compiled_prompt ?? compileScenario(sc, t, s.lang, TEMPLATES), criteria, tr: t, lang: s.lang, state, history, text })) {
        if (ev.type === 'classification') { if (ev.cls) { Object.assign(pending[0], ev.cls); yield { type: 'classification', ...ev.cls }; } }
        else if (ev.type === 'student') { pending.push({ speaker: 'student', text: ev.text }); yield { type: 'student', text: ev.text, final: true }; }
        else if (ev.type === 'trigger') { pending.push({ speaker: 'mentor', text: '', trigger: ev.trigger }); yield ev; }
        else if (ev.type === 'mentor') { pending[pending.length - 1].text = ev.text; yield { type: 'mentor', text: ev.text, final: true }; }
        else {
          const at = now();
          s.updated_at = at;
          if (ev.ended) { s.ended_at = at; s.report = sessionReport(sc.classification.leverage, history, s.goal_reached, ev.summary ?? null); }
          else { s.progress = { mis: ev.state.mis }; s.counts = ev.state.counts; s.goal_reached = ev.state.goalReached; }
          const turns = ev.ended ? [] : pending.map(p => addTurn(s, p));
          if (ownedByAdmin(s)) yield { type: 'state', ...adminState(s) };   // 관리자 세션만, done 직전 1회(D-16)
          yield ev.ended ? { type: 'done', ended: true, report: s.report } : { type: 'done', ended: false, turns };
        }
      }
    } catch (e) {
      yield { type: 'error', code: 'provider_unavailable', message: String((e as Error).message), retryable: true };
    } finally { s.turn_started_at = null; save(); }
  }
  /** 종료 버튼 = END SESSION 발화(G-34): 같은 리포트를 한 번 저장. 두 번째는 409 session_ended, 재열람은 getSession 의 저장본. */
  const end = async (s: SessionRow) => {
    for await (const ev of turn(s, 'END SESSION')) {
      if (ev.type === 'error') fail('provider_unavailable', ev.message);
      if (ev.type === 'done' && ev.ended) return ev.report;
    }
    return null;
  };

  const impl: Api = {
    signup: async b => {
      if (db.users.some(u => u.nickname.toLowerCase() === b.nickname.toLowerCase())) fail('nickname_taken');
      const t = now(), u: UserRow = { id: uuid(), nickname: b.nickname, password_hash: await hashPassword(b.password), role: 'teacher', pw_updated_at: t, created_at: t, updated_at: t };
      db.users.push(u); issue('teacher', u); save(); return me(u);   // 계정 만들기 = 바로 로그인
    },
    login: b => loginAs('teacher', b), logout: async () => logoutOf('teacher'), me: async () => me(who('teacher')), changePassword: b => changePw('teacher', b),
    adminLogin: b => loginAs('admin', b), adminLogout: async () => logoutOf('admin'), adminMe: async () => me(who('admin')), adminChangePassword: b => changePw('admin', b),

    getPractice: async () => {
      const u = who('teacher'), mine = db.groups.filter(g => g.member_ids.includes(u.id));
      const scenarios = db.scenarios.filter(s => s.status === 'published' && mine.some(g => g.scenario_ids.includes(s.id)));
      return { groups: mine.map(g => ({ id: g.id, name: g.name })), scenarios: scenarios.map(s => ({ ...toPublic(s), group_ids: mine.filter(g => g.scenario_ids.includes(s.id)).map(g => g.id) })) };
    },
    listSessions: async () => { const u = who('teacher'); return filtered({ user_id: u.id }).map(sessionRow); },
    getCurrentSession: async () => { const s = current(who(o.realm)); return s ? detail(s) : null; },
    startSession: async b => start(b.scenario_id), getSession: async id => detail(sessionOf(id)),
    // 관리자 세션의 `state` 는 AdminApi 타입으로만 보인다(createApi('admin') 이 좁힌다).
    sendTurn: async function* (id: string, b: z.infer<typeof S.TurnBody>) { yield* turn(sessionOf(id), b.text); } as Api['sendTurn'],
    endSession: async id => end(sessionOf(id)),

    listScenarios: async () => { who('admin'); return [...db.scenarios].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(toSummary); },
    createScenario: todo('createScenario', 26), getScenario: async id => { who('admin'); return toAdmin(scenario(id)); }, updateScenario: todo('updateScenario', 26), deleteScenario: todo('deleteScenario', 26),
    reviewScenario: todo('reviewScenario', 26), publishScenario: todo('publishScenario', 26), // 저장된 컴파일(게시본) 또는 초안을 활성 언어판으로 컴파일한 전문(F-31).
    getScenarioPrompt: async id => { who('admin'); const s = scenario(id); return s.compiled_prompt ?? compileScenario(s, tr(s), s.lang, TEMPLATES); },

    listUsers: async () => { who('admin'); return db.users.filter(u => u.role === 'teacher').map(userRow); },
    createUser: todo('createUser', 25), resetUserPassword: todo('resetUserPassword', 25), deleteUser: todo('deleteUser', 25),
    listGroups: async () => { who('admin'); return db.groups.map(groupOut); },
    createGroup: todo('createGroup', 25), updateGroup: todo('updateGroup', 25), deleteGroup: todo('deleteGroup', 25),

    listAdminSessions: async q => { who('admin'); return filtered(q).map(sessionRow); },
    getAdminSession: async id => { who('admin'); const s = db.sessions.find(x => x.id === id) ?? fail('not_found'); return { ...detail(s), state: adminState(s) }; }, downloadSessionsCsv: todo('downloadSessionsCsv', 27),
    getAiSettings: async () => { who('admin'); return db.ai; }, /* 읽기만(대화 테스트 ConnectedModels). 저장은 #27 */ updateAiRole: todo('updateAiRole', 27), getProviders: async () => { who('admin'); return S.ProvidersFile.parse(providers); },
  };

  // 본문·쿼리는 라우트 표의 zod 스키마로 검증한다(서버와 같은 400 validation_failed). 메서드마다 다시 쓰지 않도록 여기서 한 번 감싼다.
  for (const [name, key] of Object.entries(API_ROUTES) as [keyof Api, string][]) {
    const [method, path] = key.split(' '), route = routes.find(r => r.method === method && r.path === path)!, schema = route.body ?? route.query, hasParam = path.includes(':');
    const fn = impl[name] as (...a: unknown[]) => unknown;
    if (schema) (impl as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => { const i = hasParam ? 1 : 0, r = schema.safeParse(a[i]); if (!r.success) return rejected(r.error.issues, route.response === 'sse'); a[i] = r.data; return fn(...a); };
  }
  return impl;
}
// SSE 메서드는 스트림 시작 전 오류를 첫 next() 에서 던진다(Api.sendTurn 계약). 그래서 yield 없는 generator.
// eslint-disable-next-line require-yield
const rejected = (issues: unknown, isSse: boolean) => { const e = () => fail('validation_failed', 'validation failed', issues); return isSse ? (async function* () { e(); })() : Promise.reject(tryErr(e)); };
const tryErr = (f: () => never) => { try { f(); } catch (e) { return e; } };
