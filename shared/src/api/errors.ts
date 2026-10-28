// 오류 코드 표 — ApiError.code 후보와 그 HTTP 상태. 서버·목·화면 사전(err.<code>)이 같은 표를 본다.
// 응답 본문 스키마(S.ApiError)는 code 를 z.string() 으로 받는다: 미래의 코드가 와도 HTTP 파싱이 깨지지 않게.
import { z } from 'zod';

export const ErrorCode = z.enum([
  'validation_failed', 'invalid_effort', 'unauthorized', 'invalid_credentials', 'forbidden', 'not_found',
  'nickname_taken', 'session_active', 'session_ended', 'turn_in_progress', 'scenario_has_sessions',
  'review_failed', 'turn_limit_reached', 'too_many_attempts', 'provider_rejected', 'provider_unavailable',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ERROR_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400, invalid_effort: 400, unauthorized: 401, invalid_credentials: 401,
  forbidden: 403, not_found: 404, nickname_taken: 409, session_active: 409, session_ended: 409, turn_in_progress: 409, scenario_has_sessions: 409,
  review_failed: 422, turn_limit_reached: 422, too_many_attempts: 429, provider_rejected: 502, provider_unavailable: 502,
};
