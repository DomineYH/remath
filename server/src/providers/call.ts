// 3사 어댑터 공용: HTTP 호출·오류 평탄화(Q7)·호출 로그 1줄(Q9/Q24). 공급자별 차이는 요청 모양과 이벤트 해석(Reader)뿐이다.
import { maskKey } from '@remath/shared';
import { AdapterError, type CompleteRequest, type Role, type StreamEvent } from '@remath/shared/engine';
import { sse, type SseEvent } from './sse.ts';
import type { ProviderLog, RealProviderId } from './types.ts';

/** 어댑터 생성 옵션. fetch 는 테스트 주입용(기본 전역 fetch). */
export interface AdapterOpts { log: ProviderLog; role?: Role; fetch?: typeof fetch }
/** key = 이 요청의 API 키. 공급자 오류 글에서 가리는 데만 쓴다. */
export interface Http { url: string; headers: Record<string, string>; body?: unknown; key: string }
export type Done = Extract<StreamEvent, { type: 'done' }>;
/** SSE 이벤트 하나 → 델타 텍스트·종료(또는 그 목록)·무시(undefined). 스트림 중 오류는 throw. 호출마다 새로 만든다(상태를 가질 수 있음). */
export type Reader = (ev: SseEvent) => string | Done | (string | Done)[] | undefined;

/**
 * 결제·지출·한도 소진 오류 종류(#89). 재시도해도 접근이 돌아오지 않으므로 429 여도 거절이다.
 * 지금 문서로 확정되는 것은 OpenAI 뿐이다(error.type=insufficient_quota 와 그 error.code). Anthropic·Gemini 의 429 는 종류로
 * rate limit 과 구별되지 않아 넣지 않는다 — 공급자가 종류를 문서화하면 여기에만 더한다(docs/research/llm-providers-2026-10.md).
 */
export const QUOTA_KINDS: ReadonlySet<string> = new Set([
  'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
]);
/**
 * 로그에 남기는 공급자 오류 종류(#89 재리뷰 F1): 공급자가 문서로 밝힌 값만. 그 밖의 값(공급자 문구·키 조각·새 종류)은 어댑터를 나갈 때
 * 버린다(outbound) — 모양 규칙으로는 문자열이 오류 식별자임을 증명할 수 없다. 분류(isQuota·REJECTED)는 이 목록과 무관하게 원래 값을 본다.
 * 출처(2026-11-01 확인, docs/research/llm-providers-2026-10.md):
 * - openai: error codes 가이드(type·code), openai-python ResponseError.code(response.failed 의 error.code).
 *   실제 401 의 code 'invalid_api_key' 와 authentication_error·permission_error·not_found_error·model_not_found 는 공식 페이지에 없어 넣지 않았다.
 * - anthropic: Claude API errors 의 error.type 전부.
 * - gemini: Google API 오류 모델(AIP-193)이 가리키는 google.rpc.Code 상태 이름(OK 제외).
 */
export const LOGGED_KINDS: Readonly<Record<RealProviderId, ReadonlySet<string>>> = {
  openai: new Set([
    ...QUOTA_KINDS, 'invalid_request_error', 'rate_limit_error', 'slow_down', 'service_unavailable_error', 'server_is_overloaded',
    'previous_response_not_found', 'websocket_connection_limit_reached',
    'server_error', 'rate_limit_exceeded', 'invalid_prompt', 'data_residency_mismatch', 'bio_policy', 'misalignment_policy_violation', 'vector_store_timeout',
    'invalid_image', 'invalid_image_format', 'invalid_base64_image', 'invalid_image_url', 'image_too_large', 'image_too_small', 'image_parse_error',
    'image_content_policy_violation', 'invalid_image_mode', 'image_file_too_large', 'unsupported_image_media_type', 'empty_image_file',
    'failed_to_download_image', 'image_file_not_found',
  ]),
  anthropic: new Set([
    'invalid_request_error', 'authentication_error', 'billing_error', 'permission_error', 'not_found_error', 'conflict_error', 'request_too_large',
    'rate_limit_error', 'api_error', 'timeout_error', 'overloaded_error',
  ]),
  gemini: new Set([
    'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'UNAUTHENTICATED',
    'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS',
  ]),
};
const isQuota = (kind: unknown) => typeof kind === 'string' && QUOTA_KINDS.has(kind);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** HTTP 상태 → Q7 오류 코드. 429·5xx 만 재시도 가능, 나머지 비-2xx 는 거절. 단 429 라도 kind 가 결제·한도 소진이면 거절(#89). */
export function httpError(id: RealProviderId, status: number, message: string, kind?: unknown): AdapterError {
  const retryable = (status === 429 && !isQuota(kind)) || status >= 500;
  return new AdapterError(id, retryable ? 'provider_unavailable' : 'provider_rejected', `${status} ${message}`, { status, retryable, kind: str(kind) });
}

/** 영구 오류 이름(Q7 거절): Anthropic `*_error` type, OpenAI type/code, Gemini status — docs/research/llm-providers-2026-10.md. */
const REJECTED = /invalid|auth|permission|not_found/i;

/** 200 뒤에 온 `event: error`·실패 이벤트. kind = 공급자의 오류 type/code/status. 요청·인증·결제 한도 문제는 거절, 그 밖(과부하·rate limit·서버·모름)은 재시도 가능. */
export function streamError(id: RealProviderId, message: unknown, kind?: unknown): AdapterError {
  const rejected = typeof kind === 'string' && (REJECTED.test(kind) || isQuota(kind));
  return new AdapterError(id, rejected ? 'provider_rejected' : 'provider_unavailable', `stream error: ${String(message ?? 'unknown')}`, { retryable: !rejected, kind: str(kind) });
}

/** 비-2xx 본문의 error 객체 → 공급자 오류 종류(#89). OpenAI {error:{type,code}}, Anthropic {type:'error',error:{type}}, Gemini {error:{code:<숫자>,status}}. */
const KIND_OF: Record<RealProviderId, (e: { type?: unknown; code?: unknown; status?: unknown }) => unknown> = {
  openai: e => e.code ?? e.type, anthropic: e => e.type, gemini: e => e.status,
};

/** fetch·본문 읽기에서 던져진 것 → AdapterError. 기한 초과(TimeoutError)·네트워크는 재시도 가능, 호출자 abort 는 아니다. */
function asAdapterError(id: RealProviderId, err: unknown, signal?: AbortSignal): AdapterError {
  if (err instanceof AdapterError) return err;
  if (signal?.aborted) {
    const timeout = (signal.reason as Error | undefined)?.name === 'TimeoutError';
    return new AdapterError(id, 'provider_unavailable', timeout ? 'timeout' : 'aborted', { retryable: timeout });
  }
  return new AdapterError(id, 'provider_unavailable', `network: ${(err as Error)?.message ?? String(err)}`, { retryable: true });
}

/**
 * 어댑터를 나가는 오류의 마지막 손질(#55): 공급자 글이 되풀이한 키를 가린 뒤 300자로 자른다. 자른 뒤 가리면 잘린 키 앞부분이 샌다.
 * kind 는 로그로 가므로(#89) 이 공급자의 LOGGED_KINDS 에 없으면 지운다. 그래서 어떤 공급자 글·메시지·키 조각도 kind 로는 로그에 닿지 않는다.
 */
function outbound(e: AdapterError, key: string): AdapterError {
  if (key) e.message = e.message.replaceAll(key, maskKey(key));
  e.message = e.message.slice(0, 300);
  if (e.kind !== undefined && (e.provider === 'mock' || !LOGGED_KINDS[e.provider].has(e.kind))) e.kind = undefined;
  return e;
}

async function send(id: RealProviderId, o: AdapterOpts, http: Http, signal?: AbortSignal): Promise<Response> {
  const res = await (o.fetch ?? fetch)(http.url, {
    method: http.body === undefined ? 'GET' : 'POST', headers: http.headers, signal,
    body: http.body === undefined ? undefined : JSON.stringify(http.body),
  });
  if (res.ok) return res;
  const text = await res.text().catch(() => '');
  let message = res.statusText, kind: unknown;
  try {
    const e = JSON.parse(text)?.error;
    message = e?.message ?? message;
    if (e && typeof e === 'object') kind = KIND_OF[id](e);
  } catch { /* 본문이 JSON 이 아니면 상태 문구, 종류 없음 */ }
  throw httpError(id, res.status, message, kind);
}

/** 스트리밍 호출 한 번. 끝나면(성공·실패·중단) 로그 1줄 — 모델·시간·사용량·코드·HTTP 상태·오류 종류(LOGGED_KINDS 의 문서 값만)뿐, 키·본문·공급자 메시지는 절대 넣지 않는다. */
export async function* stream(id: RealProviderId, o: AdapterOpts, req: CompleteRequest, http: Http, read: Reader): AsyncGenerator<StreamEvent> {
  const t0 = performance.now();
  let done: Done | undefined, fail: AdapterError | undefined, code = 'cancelled';
  try {
    const res = await send(id, o, http, req.signal);
    if (!res.body) throw streamError(id, 'empty body');
    for await (const ev of sse(res.body)) {
      let r: ReturnType<Reader>;
      // JSON.parse 실패 = 공급자 스트림 이상. 메시지에 본문 조각이 섞이므로 싣지 않는다.
      try { r = read(ev); } catch (err) { throw err instanceof SyntaxError ? streamError(id, 'unparseable event data') : err; }
      for (const out of [r ?? []].flat()) {
        if (typeof out !== 'string') { done = out; yield out; return; }
        if (out) yield { type: 'delta', text: out };
      }
    }
    throw streamError(id, 'stream ended without a final event');
  } catch (err) {
    const e = outbound(asAdapterError(id, err, req.signal), http.key); code = e.code; fail = e; throw e;
  } finally {
    const line = { provider: id, model: req.model, ...o.role && { role: o.role }, ms: Math.round(performance.now() - t0), ok: !!done, ...done ? { usage: done.usage, stop: done.stopReason } : { code, status: fail?.status, kind: fail?.kind } };
    if (done) o.log.info(line, 'llm call'); else o.log.warn(line, 'llm call failed');
    if (done?.stopReason === 'length') o.log.warn({ provider: id, model: req.model, ...o.role && { role: o.role } }, 'llm output truncated (stop: length)');
  }
}

/** 키 확인 전체(헤더+본문)의 기한. 없으면 멈춘 공급자에 관리자 저장이 영영 걸린다. */
export const LIST_MODELS_TIMEOUT_MS = 10_000;

/** 키 확인용 모델 목록 GET(Q23). 유효성은 상태만으로 정한다: 2xx = 유효(#55). 그 뒤 id 읽기는 최선 — 본문 실패·기한 초과·모양 다름이면 빈 목록. */
export async function listModels(id: RealProviderId, o: AdapterOpts, http: Http, ids: (json: never) => string[]): Promise<string[]> {
  const signal = AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS);
  let res: Response;
  try { res = await send(id, o, http, signal); } catch (err) { throw outbound(asAdapterError(id, err, signal), http.key); }
  // 주입된 fetch 의 본문은 signal 을 모를 수 있어 기한과 경주시킨다.
  const expired = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  try { return ids(await Promise.race([res.json(), expired]) as never); } catch { return []; }
}
