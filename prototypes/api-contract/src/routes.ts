// 엔드포인트 표 — 서버 라우트 등록과 클라이언트 인터페이스(티켓 13)가 같은 표를 본다. 경로·실 분리·스키마가 한 곳.
// realm: teacher = 예비교사 쿠키, admin = 관리자 쿠키, any = 둘 중 하나 + 세션 소유자 검사(관리자 대화 테스트가 같은 경로를 쓴다).
import type { ZodType } from 'zod';
import * as S from './schemas.ts';

export type Realm = 'none' | 'teacher' | 'admin' | 'any';
export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; realm: Realm;
  body?: ZodType; query?: ZodType;
  response: ZodType | 'sse' | 'csv' | 'none';   // none = 204
  errors: string[];                            // ApiError.code 후보(공통 401 unauthorized·403 forbidden·400 validation_failed 는 생략)
}

const sessionErrors = ['not_found'];
export const routes: Route[] = [
  // 인증 — 예비교사. 쿠키 remath_teacher(7일). 계정 만들기는 바로 로그인(PRD 3절).
  { method: 'POST', path: '/api/auth/signup', realm: 'none', body: S.Credentials, response: S.Me, errors: ['nickname_taken'] },
  { method: 'POST', path: '/api/auth/login', realm: 'none', body: S.Credentials, response: S.Me, errors: ['invalid_credentials', 'too_many_attempts'] },
  { method: 'POST', path: '/api/auth/logout', realm: 'teacher', response: 'none', errors: [] },
  { method: 'GET', path: '/api/auth/me', realm: 'teacher', response: S.Me, errors: [] },
  { method: 'PUT', path: '/api/auth/password', realm: 'teacher', body: S.PasswordChange, response: 'none', errors: ['invalid_credentials'] },
  // 인증 — 관리자. 쿠키 remath_admin(12시간), /admin 화면에서만 발급(AUTH-3). 실패 메시지는 구분 없음.
  { method: 'POST', path: '/api/admin/auth/login', realm: 'none', body: S.Credentials, response: S.Me, errors: ['invalid_credentials', 'too_many_attempts'] },
  { method: 'POST', path: '/api/admin/auth/logout', realm: 'admin', response: 'none', errors: [] },
  { method: 'GET', path: '/api/admin/auth/me', realm: 'admin', response: S.Me, errors: [] },
  { method: 'PUT', path: '/api/admin/auth/password', realm: 'admin', body: S.PasswordChange, response: 'none', errors: ['invalid_credentials'] },

  // 예비교사 — 학생 선택·연습 세션·내 기록
  { method: 'GET', path: '/api/practice', realm: 'teacher', response: S.PracticeHome, errors: [] },
  { method: 'GET', path: '/api/sessions', realm: 'teacher', response: S.SessionRow.array(), errors: [] },            // 내 기록, 최신순, 페이지네이션 없음
  { method: 'GET', path: '/api/sessions/current', realm: 'any', response: S.SessionDetail.nullable(), errors: [] }, // C15 새로고침 복구. 없으면 null
  { method: 'POST', path: '/api/sessions', realm: 'any', body: S.StartSession, response: S.SessionDetail, errors: ['not_found', 'session_active'] }, // 201. 인사 발화(seq 1, student)가 들어 있다
  { method: 'GET', path: '/api/sessions/:id', realm: 'any', response: S.SessionDetail, errors: sessionErrors },
  { method: 'POST', path: '/api/sessions/:id/turns', realm: 'any', body: S.TurnBody, response: 'sse', errors: [...sessionErrors, 'session_ended', 'turn_in_progress', 'turn_limit_reached'] },
  { method: 'POST', path: '/api/sessions/:id/end', realm: 'any', response: S.SessionReport.nullable(), errors: [...sessionErrors, 'session_ended', 'turn_in_progress'] }, // 종료 버튼 = END SESSION 발화와 같은 결과

  // 관리자 — 시나리오
  { method: 'GET', path: '/api/admin/scenarios', realm: 'admin', response: S.ScenarioSummary.array(), errors: [] },
  { method: 'POST', path: '/api/admin/scenarios', realm: 'admin', body: S.ScenarioInput, response: S.ScenarioAdmin, errors: [] },                 // 201, status=draft, slug 는 서버 생성
  { method: 'GET', path: '/api/admin/scenarios/:id', realm: 'admin', response: S.ScenarioAdmin, errors: ['not_found'] },
  { method: 'PUT', path: '/api/admin/scenarios/:id', realm: 'admin', body: S.ScenarioInput, response: S.ScenarioAdmin, errors: ['not_found'] },  // 초안 저장: 항상 status=draft, compiled_prompt=null
  { method: 'DELETE', path: '/api/admin/scenarios/:id', realm: 'admin', response: 'none', errors: ['not_found', 'scenario_has_sessions'] },       // 기록이 있으면 409
  { method: 'GET', path: '/api/admin/scenarios/:id/review', realm: 'admin', response: S.ReviewResult, errors: ['not_found'] },
  { method: 'POST', path: '/api/admin/scenarios/:id/publish', realm: 'admin', body: S.PublishBody, response: S.ScenarioAdmin, errors: ['not_found', 'review_failed'] }, // 검수 통과 시 컴파일·게시(C11)
  { method: 'GET', path: '/api/admin/scenarios/:id/prompt', realm: 'admin', response: S.Compiled, errors: ['not_found'] },                       // 저장된 초안/게시본을 활성 lang 으로 컴파일한 전문
  // 관리자 대화 테스트: POST /api/sessions 를 관리자 쿠키로 호출(초안 시나리오 허용). 별도 엔드포인트 없음.

  // 관리자 — 사용자·그룹
  { method: 'GET', path: '/api/admin/users', realm: 'admin', response: S.UserRow.array(), errors: [] },
  { method: 'POST', path: '/api/admin/users', realm: 'admin', body: S.Credentials, response: S.UserRow, errors: ['nickname_taken'] },
  { method: 'PUT', path: '/api/admin/users/:id/password', realm: 'admin', body: S.PasswordReset, response: 'none', errors: ['not_found'] }, // 재설정 + 그 사용자의 로그인 모두 종료
  { method: 'DELETE', path: '/api/admin/users/:id', realm: 'admin', response: 'none', errors: ['not_found'] },     // 기록 cascade(USR-1). 삭제 확인창의 건수는 UserRow.session_count
  { method: 'GET', path: '/api/admin/groups', realm: 'admin', response: S.Group.array(), errors: [] },
  { method: 'POST', path: '/api/admin/groups', realm: 'admin', body: S.GroupInput, response: S.Group, errors: [] },
  { method: 'PUT', path: '/api/admin/groups/:id', realm: 'admin', body: S.GroupInput, response: S.Group, errors: ['not_found'] }, // 구성원·시나리오는 전체 치환
  { method: 'DELETE', path: '/api/admin/groups/:id', realm: 'admin', response: 'none', errors: ['not_found'] },

  // 관리자 — 대화 기록·CSV·AI 설정
  { method: 'GET', path: '/api/admin/sessions', realm: 'admin', query: S.SessionFilter, response: S.SessionRow.array(), errors: [] },   // 최신순, 페이지네이션 없음
  { method: 'GET', path: '/api/admin/sessions/:id', realm: 'admin', response: S.SessionDetail, errors: ['not_found'] },
  { method: 'GET', path: '/api/admin/sessions.csv', realm: 'admin', query: S.SessionFilter, response: 'csv', errors: [] },            // 사용자별·시나리오별 CSV 는 같은 필터
  { method: 'GET', path: '/api/admin/ai', realm: 'admin', response: S.AiSettings, errors: [] },
  { method: 'PUT', path: '/api/admin/ai/:role', realm: 'admin', body: S.AiRoleInput, response: S.AiRoleSetting, errors: ['invalid_effort', 'provider_rejected'] }, // 3단계
  // GET /api/admin/ai/providers — 형태는 "providers.json 최소 스키마 결정"(티켓 18)
];
