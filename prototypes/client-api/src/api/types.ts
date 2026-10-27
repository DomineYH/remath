// 클라이언트 API 경계 (티켓 13) — 저장소에서는 `client/src/api/types.ts`.
// 메서드 하나 = 라우트 표(`shared/src/api/routes.ts`)의 행 하나. 이름은 경로에서 유도했고 `API_ROUTES` 가 그 대응을 적는다(check.ts 가 1:1 을 확인).
// 두 구현(HTTP·목)은 이 인터페이스만 만족하면 되고, 화면 코드는 `createApi()` 가 돌려준 객체만 본다.
import type { z } from 'zod';
import * as S from '../../../api-contract/src/schemas.ts';

type T<X extends z.ZodType> = z.infer<X>;
export type SseEvent = T<typeof S.SseEvent>;
/** `any` 라우트(세션 경로)에서 어느 로그인으로 행동할지. 화면이 둘 중 하나로 `createApi` 를 만든다(관리자 대화 테스트 = admin). */
export type ClientRealm = 'teacher' | 'admin';

/** 두 구현이 던지는 유일한 오류. `body` 는 응답 `{error:{code,message,details}}` 그대로. 상태 코드는 SPEC 4절 표. */
export class ApiError extends Error {
  status: number; body: T<typeof S.ApiError>;
  constructor(status: number, body: T<typeof S.ApiError>) { super(body.error.message); this.name = 'ApiError'; this.status = status; this.body = body; }
  get code() { return this.body.error.code; }
}

export interface Api {
  // 인증 — 예비교사(remath_teacher)
  signup(body: T<typeof S.Credentials>): Promise<T<typeof S.Me>>;
  login(body: T<typeof S.Credentials>): Promise<T<typeof S.Me>>;
  logout(): Promise<void>;
  me(): Promise<T<typeof S.Me>>;
  changePassword(body: T<typeof S.PasswordChange>): Promise<void>;
  // 인증 — 관리자(remath_admin)
  adminLogin(body: T<typeof S.Credentials>): Promise<T<typeof S.Me>>;
  adminLogout(): Promise<void>;
  adminMe(): Promise<T<typeof S.Me>>;
  adminChangePassword(body: T<typeof S.PasswordChange>): Promise<void>;
  // 예비교사 — 학생 선택·연습 세션·내 기록 (세션 경로는 realm 에 따라 관리자 대화 테스트도 같은 메서드)
  getPractice(): Promise<T<typeof S.PracticeHome>>;
  listSessions(): Promise<T<typeof S.SessionRow>[]>;
  getCurrentSession(): Promise<T<typeof S.SessionDetail> | null>;
  startSession(body: T<typeof S.StartSession>): Promise<T<typeof S.SessionDetail>>;
  getSession(id: string): Promise<T<typeof S.SessionDetail>>;
  /** 스트림 시작 전 오류(404·409·422)는 첫 next() 에서 ApiError throw, 시작 후 오류는 `error` 이벤트. */
  sendTurn(id: string, body: T<typeof S.TurnBody>): AsyncIterable<SseEvent>;
  endSession(id: string): Promise<T<typeof S.SessionReport> | null>;
  // 관리자 — 시나리오
  listScenarios(): Promise<T<typeof S.ScenarioSummary>[]>;
  createScenario(body: T<typeof S.ScenarioInput>): Promise<T<typeof S.ScenarioAdmin>>;
  getScenario(id: string): Promise<T<typeof S.ScenarioAdmin>>;
  updateScenario(id: string, body: T<typeof S.ScenarioInput>): Promise<T<typeof S.ScenarioAdmin>>;
  deleteScenario(id: string): Promise<void>;
  reviewScenario(id: string): Promise<T<typeof S.ReviewResult>>;
  publishScenario(id: string, body: T<typeof S.PublishBody>): Promise<T<typeof S.ScenarioAdmin>>;
  getScenarioPrompt(id: string): Promise<T<typeof S.Compiled>>;
  // 관리자 — 사용자·그룹
  listUsers(): Promise<T<typeof S.UserRow>[]>;
  createUser(body: T<typeof S.Credentials>): Promise<T<typeof S.UserRow>>;
  resetUserPassword(id: string, body: T<typeof S.PasswordReset>): Promise<void>;
  deleteUser(id: string): Promise<void>;
  listGroups(): Promise<T<typeof S.Group>[]>;
  createGroup(body: T<typeof S.GroupInput>): Promise<T<typeof S.Group>>;
  updateGroup(id: string, body: T<typeof S.GroupInput>): Promise<T<typeof S.Group>>;
  deleteGroup(id: string): Promise<void>;
  // 관리자 — 대화 기록·CSV·AI 설정
  listAdminSessions(query: T<typeof S.SessionFilter>): Promise<T<typeof S.SessionRow>[]>;
  getAdminSession(id: string): Promise<T<typeof S.SessionDetail>>;
  downloadSessionsCsv(query: T<typeof S.SessionFilter>): Promise<Blob>;   // 바이트 그대로(BOM 보존) → <a download>. text() 는 BOM 을 벗긴다
  getAiSettings(): Promise<T<typeof S.AiSettings>>;
  updateAiRole(role: 'student' | 'mentor' | 'analysis', body: T<typeof S.AiRoleInput>): Promise<T<typeof S.AiRoleSetting>>;
}

/** 메서드 ↔ 라우트. 인자 규칙: 경로에 `:param` 이 있으면 첫 인자, body 나 query 가 있으면 그다음 인자. HTTP 구현은 이 표만으로 모든 메서드를 만든다. */
export const API_ROUTES: Record<keyof Api, `${'GET' | 'POST' | 'PUT' | 'DELETE'} ${string}`> = {
  signup: 'POST /api/auth/signup', login: 'POST /api/auth/login', logout: 'POST /api/auth/logout', me: 'GET /api/auth/me', changePassword: 'PUT /api/auth/password',
  adminLogin: 'POST /api/admin/auth/login', adminLogout: 'POST /api/admin/auth/logout', adminMe: 'GET /api/admin/auth/me', adminChangePassword: 'PUT /api/admin/auth/password',
  getPractice: 'GET /api/practice', listSessions: 'GET /api/sessions', getCurrentSession: 'GET /api/sessions/current', startSession: 'POST /api/sessions',
  getSession: 'GET /api/sessions/:id', sendTurn: 'POST /api/sessions/:id/turns', endSession: 'POST /api/sessions/:id/end',
  listScenarios: 'GET /api/admin/scenarios', createScenario: 'POST /api/admin/scenarios', getScenario: 'GET /api/admin/scenarios/:id', updateScenario: 'PUT /api/admin/scenarios/:id',
  deleteScenario: 'DELETE /api/admin/scenarios/:id', reviewScenario: 'GET /api/admin/scenarios/:id/review', publishScenario: 'POST /api/admin/scenarios/:id/publish', getScenarioPrompt: 'GET /api/admin/scenarios/:id/prompt',
  listUsers: 'GET /api/admin/users', createUser: 'POST /api/admin/users', resetUserPassword: 'PUT /api/admin/users/:id/password', deleteUser: 'DELETE /api/admin/users/:id',
  listGroups: 'GET /api/admin/groups', createGroup: 'POST /api/admin/groups', updateGroup: 'PUT /api/admin/groups/:id', deleteGroup: 'DELETE /api/admin/groups/:id',
  listAdminSessions: 'GET /api/admin/sessions', getAdminSession: 'GET /api/admin/sessions/:id', downloadSessionsCsv: 'GET /api/admin/sessions.csv',
  getAiSettings: 'GET /api/admin/ai', updateAiRole: 'PUT /api/admin/ai/:role',
};
