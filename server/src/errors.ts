// 오류 응답 = {error:{code,message,details}}, HTTP 상태는 ERROR_STATUS[code]에서만(M-2, I-34).
import type { ErrorCode } from '@remath/shared';

export class ApiFail extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  constructor(code: ErrorCode, message: string = code, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
