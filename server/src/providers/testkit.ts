// 어댑터 단위 테스트용 가짜 fetch·로거. 네트워크 없음(Q30).
import type { ProviderLog } from './types.ts';

export const body = (...chunks: string[]) => new ReadableStream<Uint8Array>({
  start(c) { const enc = new TextEncoder(); for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); },
});

/** 픽스처 SSE 블록들을 이벤트 단위로 이어 붙인다. */
export const sseText = (...events: string[]) => events.map(e => `${e.trim()}\n\n`).join('');

export interface Call { url: string; method: string; headers: Record<string, string>; body?: unknown }

/** 응답을 정해 둔 가짜 fetch. 호출 기록을 남기고 signal 이 끊기면 실제 fetch 처럼 그 reason 으로 거절한다. */
export function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body === undefined ? undefined : JSON.parse(init.body as string) });
    init.signal?.throwIfAborted();
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export const sseResponse = (text: string, status = 200) => new Response(body(text), { status, headers: { 'content-type': 'text/event-stream' } });
export const jsonResponse = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });

export function memLog() {
  const lines: { level: 'info' | 'warn'; obj: object; msg?: string }[] = [];
  const log: ProviderLog = { info: (obj, msg) => lines.push({ level: 'info', obj, msg }), warn: (obj, msg) => lines.push({ level: 'warn', obj, msg }) };
  return { log, lines };
}

/** 키의 8자 이상 연속 조각이 text 에 있는가(#55 키 노출 검사). */
export const leaksKey = (text: string, key: string) => Array.from({ length: key.length - 7 }, (_, i) => key.slice(i, i + 8)).some(k => text.includes(k));
