// 어댑터 3종 픽스처 테스트(#56). 픽스처 = docs/research/llm-providers-2026-10.md 의 실제 응답 형태를 손으로 적은 SSE.
import { AdapterError, collect, type CompleteRequest, type Provider, type Role, type StreamEvent } from '@remath/shared/engine';
import { describe, expect, it, vi } from 'vitest';
import { anthropicProvider } from './anthropic.ts';
import { geminiProvider } from './gemini.ts';
import { openaiProvider } from './openai.ts';
import { providersFor } from './index.ts';
import { QUOTA_KINDS, type AdapterOpts } from './call.ts';
import { fakeFetch, jsonResponse, leaksKey, memLog, sseResponse, sseText } from './testkit.ts';

const KEY = 'sk-test-SECRET-KEY-123';
const REQ: CompleteRequest = { system: 'SYSTEM-PROMPT-TEXT', messages: [{ role: 'user', content: 'USER-UTTERANCE' }, { role: 'assistant', content: 'BOT-REPLY' }, { role: 'user', content: '두 번째 발화' }], model: 'm-1' };
const drain = async (it: AsyncIterable<StreamEvent>) => { const out: StreamEvent[] = []; for await (const e of it) out.push(e); return out; };

const OPENAI_OK = sseText(
  `event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","status":"in_progress","model":"gpt-6.1-sol-2026-09-01","output":[]}}`,
  `event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}`,
  `event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":2,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"반은 "}`,
  `event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":3,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"이분의 일"}`,
  `event: response.output_text.done
data: {"type":"response.output_text.done","sequence_number":4,"item_id":"msg_1","output_index":0,"content_index":0,"text":"반은 이분의 일"}`,
  `event: response.completed
data: {"type":"response.completed","sequence_number":5,"response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-6.1-sol-2026-09-01","usage":{"input_tokens":42,"output_tokens":7,"total_tokens":49}}}`,
);

const OPENAI_MID_ERROR = sseText(
  `event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":2,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"반은 "}`,
  `event: error
data: {"type":"error","sequence_number":3,"code":"server_error","message":"The server had an error","param":null}`,
);
// 200 뒤 영구 오류(Q7): 요청·인증 문제는 거절로 남는다.
const OPENAI_MID_REJECTED = sseText(
  `event: error
data: {"type":"error","sequence_number":1,"code":"invalid_prompt","message":"Invalid prompt","param":null}`,
);
const OPENAI_LENGTH = sseText(
  `event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":2,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"반은"}`,
  `event: response.incomplete
data: {"type":"response.incomplete","sequence_number":3,"response":{"id":"resp_1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"model":"gpt-6.1-sol-2026-09-01","usage":{"input_tokens":42,"output_tokens":1024}}}`,
);

const ANTHROPIC_OK = sseText(
  `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":42,"output_tokens":1}}}`,
  `event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
  `event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"생각 중"}}`,
  `event: content_block_stop
data: {"type":"content_block_stop","index":0}`,
  `event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
  `event: ping
data: {"type": "ping"}`,
  `event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"반은 "}}`,
  `event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"이분의 일"}}`,
  `event: content_block_stop
data: {"type":"content_block_stop","index":1}`,
  `event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":7}}`,
  `event: message_stop
data: {"type":"message_stop"}`,
);
const ANTHROPIC_MID_ERROR = sseText(
  `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5-5","usage":{"input_tokens":42,"output_tokens":1}}}`,
  `event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"반은 "}}`,
  `event: error
data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`,
);
const ANTHROPIC_MID_REJECTED = sseText(
  `event: error
data: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}`,
);
const ANTHROPIC_LENGTH = sseText(
  `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5-5","usage":{"input_tokens":42,"output_tokens":1}}}`,
  `event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"반은"}}`,
  `event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":1024}}`,
  `event: message_stop
data: {"type":"message_stop"}`,
);

// streamGenerateContent?alt=sse: 이벤트 이름 없이 GenerateContentResponse 청크만 온다. 마지막 청크에 finishReason·usageMetadata.
const GEMINI_OK = sseText(
  `data: {"candidates":[{"content":{"parts":[{"text":"생각 중","thought":true}],"role":"model"},"index":0}],"usageMetadata":{"promptTokenCount":42,"totalTokenCount":42},"modelVersion":"gemini-3.8-flash","responseId":"r1"}`,
  `data: {"candidates":[{"content":{"parts":[{"text":"반은 "}],"role":"model"},"index":0}],"usageMetadata":{"promptTokenCount":42,"totalTokenCount":42},"modelVersion":"gemini-3.8-flash","responseId":"r1"}`,
  `data: {"candidates":[{"content":{"parts":[{"text":"이분의 일"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":42,"candidatesTokenCount":7,"thoughtsTokenCount":30,"totalTokenCount":79},"modelVersion":"gemini-3.8-flash","responseId":"r1"}`,
);
const GEMINI_MID_ERROR = sseText(
  `data: {"candidates":[{"content":{"parts":[{"text":"반은 "}],"role":"model"},"index":0}],"modelVersion":"gemini-3.8-flash"}`,
  `data: {"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}`,
);
const GEMINI_MID_REJECTED = sseText(
  `data: {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}`,
);
const GEMINI_LENGTH = sseText(
  `data: {"candidates":[{"content":{"parts":[{"text":"반은"}],"role":"model"},"finishReason":"MAX_TOKENS","index":0}],"usageMetadata":{"promptTokenCount":42,"candidatesTokenCount":1024,"totalTokenCount":1066},"modelVersion":"gemini-3.8-flash"}`,
);

interface Case {
  make: (key: string, o: AdapterOpts) => Provider;
  ok: string; okEvents: StreamEvent[]; midError: string; midRejected: string; length: string;
  /** 비-2xx 오류 본문(공급자별 형태). */
  errorBody: (message: string) => unknown;
  /** errorBody·midError 의 공급자 오류 종류(#89)와 midError 의 공급자 메시지(로그에 없어야 한다). */
  kinds: { http: string; mid: string; midMessage: string };
  /** 오류 종류만 바꾼 비-2xx 본문(#89 종류 위생 검사). */
  kindBody: (kind: string) => unknown;
  request: { url: string; headers: Record<string, string>; body: unknown; effort: unknown };
  models: { url: string; json: unknown; ids: string[] };
}

const CASES: Record<string, Case> = {
  openai: {
    make: openaiProvider, ok: OPENAI_OK, midError: OPENAI_MID_ERROR, midRejected: OPENAI_MID_REJECTED, length: OPENAI_LENGTH,
    okEvents: [
      { type: 'delta', text: '반은 ' }, { type: 'delta', text: '이분의 일' },
      { type: 'done', model: 'gpt-6.1-sol-2026-09-01', stopReason: 'end', usage: { input: 42, output: 7 } },
    ],
    errorBody: message => ({ error: { message, type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }),
    kinds: { http: 'invalid_api_key', mid: 'server_error', midMessage: 'The server had an error' },
    kindBody: kind => ({ error: { message: 'm', type: kind, param: null, code: null } }),
    request: {
      url: 'https://api.openai.com/v1/responses',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: { model: 'm-1', instructions: 'SYSTEM-PROMPT-TEXT', input: REQ.messages, stream: true },
      effort: { reasoning: { effort: 'high' } },
    },
    models: { url: 'https://api.openai.com/v1/models', json: { object: 'list', data: [{ id: 'gpt-6.1-sol', object: 'model', created: 1, owned_by: 'openai' }, { id: 'gpt-5.5', object: 'model', created: 1, owned_by: 'openai' }] }, ids: ['gpt-6.1-sol', 'gpt-5.5'] },
  },
  anthropic: {
    make: anthropicProvider, ok: ANTHROPIC_OK, midError: ANTHROPIC_MID_ERROR, midRejected: ANTHROPIC_MID_REJECTED, length: ANTHROPIC_LENGTH,
    okEvents: [
      { type: 'delta', text: '반은 ' }, { type: 'delta', text: '이분의 일' },
      { type: 'done', model: 'claude-sonnet-5-5', stopReason: 'end', usage: { input: 42, output: 7 } },
    ],
    errorBody: message => ({ type: 'error', error: { type: 'authentication_error', message }, request_id: 'req_1' }),
    kinds: { http: 'authentication_error', mid: 'overloaded_error', midMessage: 'Overloaded' },
    kindBody: kind => ({ type: 'error', error: { type: kind, message: 'm' }, request_id: 'req_1' }),
    request: {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
      body: { model: 'm-1', max_tokens: 1024, system: 'SYSTEM-PROMPT-TEXT', messages: REQ.messages, stream: true },
      effort: { output_config: { effort: 'high' } },
    },
    models: { url: 'https://api.anthropic.com/v1/models', json: { data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' }, ids: ['claude-opus-5-5'] },
  },
  gemini: {
    make: geminiProvider, ok: GEMINI_OK, midError: GEMINI_MID_ERROR, midRejected: GEMINI_MID_REJECTED, length: GEMINI_LENGTH,
    okEvents: [
      { type: 'delta', text: '반은 ' }, { type: 'delta', text: '이분의 일' },
      { type: 'done', model: 'gemini-3.8-flash', stopReason: 'end', usage: { input: 42, output: 37 } },   // output = 응답 + 생각 토큰(3사 모두 과금 기준)
    ],
    errorBody: message => ({ error: { code: 401, message, status: 'UNAUTHENTICATED' } }),
    kinds: { http: 'UNAUTHENTICATED', mid: 'UNAVAILABLE', midMessage: 'The model is overloaded' },
    kindBody: kind => ({ error: { code: 429, message: 'm', status: kind } }),
    request: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models/m-1:streamGenerateContent?alt=sse',
      headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' },
      body: {
        system_instruction: { parts: [{ text: 'SYSTEM-PROMPT-TEXT' }] },
        contents: [{ role: 'user', parts: [{ text: 'USER-UTTERANCE' }] }, { role: 'model', parts: [{ text: 'BOT-REPLY' }] }, { role: 'user', parts: [{ text: '두 번째 발화' }] }],
      },
      effort: { generation_config: { thinking_config: { thinking_level: 'high' } } },
    },
    models: { url: 'https://generativelanguage.googleapis.com/v1beta/models', json: { models: [{ name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' }, { name: 'models/gemini-4-argon' }], nextPageToken: 'p2' }, ids: ['gemini-3.8-flash', 'gemini-4-argon'] },
  },
};

describe.each(Object.entries(CASES))('%s adapter', (_, c) => {
  const setup = (respond: () => Response | Promise<Response>, role?: Role) => {
    const f = fakeFetch(respond), m = memLog();
    return { ...f, ...m, p: c.make(KEY, { log: m.log, fetch: f.fetch, role }) };
  };
  const rejection = (it: AsyncIterable<StreamEvent>) => drain(it).then(() => { throw new Error('expected a throw'); }, (e: unknown) => e);

  it('streams text deltas in order, accumulating to the full text, then one done with usage and stop reason', async () => {
    const { p } = setup(() => sseResponse(c.ok));
    const events = await drain(p.complete(REQ));
    expect(events).toEqual(c.okEvents);
    expect((await collect(p.complete(REQ))).text).toBe('반은 이분의 일');
  });

  it('maps a length stop to stopReason length and logs one warning (Q24)', async () => {
    const { p, lines } = setup(() => sseResponse(c.length));
    const events = await drain(p.complete(REQ));
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'length' });
    expect(lines.map(l => l.level)).toEqual(['info', 'warn']);
  });

  it('sends the request without any effort field when effort is absent', async () => {
    const { p, calls } = setup(() => sseResponse(c.ok));
    await drain(p.complete(REQ));
    expect(calls).toEqual([{ url: c.request.url, method: 'POST', headers: c.request.headers, body: c.request.body }]);
  });

  it('puts effort at the provider path when given', async () => {
    const { p, calls } = setup(() => sseResponse(c.ok));
    await drain(p.complete({ ...REQ, effort: 'high' }));
    expect(calls[0]!.body).toEqual({ ...c.request.body as object, ...c.request.effort as object });
  });

  it('401 → AdapterError provider_rejected, not retryable', async () => {
    const { p } = setup(() => jsonResponse(c.errorBody('Invalid API key'), 401));
    const e = await rejection(p.complete(REQ));
    expect(e).toBeInstanceOf(AdapterError);
    expect(e).toMatchObject({ provider: p.id, code: 'provider_rejected', status: 401, retryable: false });
    expect((e as Error).message).toContain('Invalid API key');
  });

  it('429 and 5xx → AdapterError provider_unavailable, retryable', async () => {
    for (const status of [429, 500, 503]) {
      const { p } = setup(() => jsonResponse(c.errorBody('slow down'), status));
      expect(await rejection(p.complete(REQ))).toMatchObject({ code: 'provider_unavailable', status, retryable: true });
    }
  });

  it('429 without an error kind (rate limit) stays provider_unavailable, retryable, status 429 (#89)', async () => {
    const { p } = setup(() => jsonResponse({ error: { message: 'slow down' } }, 429));
    const e = await rejection(p.complete(REQ)) as AdapterError;
    expect(e).toMatchObject({ code: 'provider_unavailable', status: 429, retryable: true });
    expect(e.kind).toBeUndefined();
    const t = await rejection(setup(() => new Response('<html>Too Many Requests</html>', { status: 429 })).p.complete(REQ)) as AdapterError;
    expect(t).toMatchObject({ code: 'provider_unavailable', status: 429, retryable: true });
    expect(t.kind).toBeUndefined();   // 본문이 JSON 이 아니면 종류 없음
  });

  it('the error kind is taken from the non-2xx body and the stream error (#89)', async () => {
    expect(await rejection(setup(() => jsonResponse(c.errorBody('Invalid API key'), 401)).p.complete(REQ))).toMatchObject({ status: 401, kind: c.kinds.http });
    await expect(setup(() => jsonResponse(c.errorBody('bad key'), 401)).p.listModels()).rejects.toMatchObject({ status: 401, kind: c.kinds.http });
    expect(await rejection(setup(() => sseResponse(c.midError)).p.complete(REQ))).toMatchObject({ kind: c.kinds.mid });
  });

  it('an error kind over 64 chars or outside [A-Za-z0-9_.-] is dropped — not on the error, not in the log (#89)', async () => {
    const ok64 = 'k'.repeat(64);
    const kept = setup(() => jsonResponse(c.kindBody(ok64), 429));
    expect(await rejection(kept.p.complete(REQ))).toMatchObject({ kind: ok64 });
    expect(kept.lines[0]!.obj).toMatchObject({ kind: ok64 });
    for (const bad of ['k'.repeat(65), 'quota exceeded for sk-test-SECRET', 'rate_limit_error\n', '한도_초과', '']) {
      const s = setup(() => jsonResponse(c.kindBody(bad), 429));
      const e = await rejection(s.p.complete(REQ)) as AdapterError;
      expect(e).toMatchObject({ code: 'provider_unavailable', status: 429 });
      expect(e.kind).toBeUndefined();
      expect(s.lines).toHaveLength(1);
      expect((s.lines[0]!.obj as { kind?: string }).kind).toBeUndefined();
      if (bad) expect(JSON.stringify(s.lines)).not.toContain(bad);
    }
  });

  it('a mid-stream error event throws after the deltas already sent', async () => {
    const { p } = setup(() => sseResponse(c.midError));
    const seen: StreamEvent[] = [];
    const e = await rejection((async function* () { for await (const ev of p.complete(REQ)) { seen.push(ev); yield ev; } })());
    expect(seen).toEqual([{ type: 'delta', text: '반은 ' }]);
    expect(e).toMatchObject({ provider: p.id, code: 'provider_unavailable', retryable: true });
  });

  it('a mid-stream request/auth error keeps Q7: provider_rejected, not retryable', async () => {
    const { p } = setup(() => sseResponse(c.midRejected));
    expect(await rejection(p.complete(REQ))).toMatchObject({ provider: p.id, code: 'provider_rejected', retryable: false });
  });

  it('a stream that ends without a final event throws', async () => {
    const { p } = setup(() => sseResponse(''));
    expect(await rejection(p.complete(REQ))).toBeInstanceOf(AdapterError);
  });

  it('an unparseable data line is a stream error, not a network error (still retryable)', async () => {
    const { p } = setup(() => sseResponse('data: {not json\n\n'));
    const e = await rejection(p.complete(REQ)) as AdapterError;
    expect(e).toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(e.message).toMatch(/^stream error: /);
  });

  it('abort → AdapterError, not retryable; a timeout abort is retryable', async () => {
    const { p, calls } = setup(() => sseResponse(c.ok));
    const e = await rejection(p.complete({ ...REQ, signal: AbortSignal.abort() }));
    expect(e).toMatchObject({ code: 'provider_unavailable', message: 'aborted', retryable: false });
    expect(calls[0]!).toBeDefined();   // signal 은 fetch 에 전달된다(가짜 fetch 가 그 signal 로 거절)
    const t = await rejection(p.complete({ ...REQ, signal: AbortSignal.abort(new DOMException('deadline', 'TimeoutError')) }));
    expect(t).toMatchObject({ message: 'timeout', retryable: true });
  });

  it('network failure → retryable AdapterError', async () => {
    const { p } = setup(() => { throw new TypeError('fetch failed'); });
    expect(await rejection(p.complete(REQ))).toMatchObject({ code: 'provider_unavailable', retryable: true });
  });

  it('logs one line per call with provider/model/role/ms/ok/usage/stop, and never the key or any text', async () => {
    const { p, lines } = setup(() => sseResponse(c.ok), 'student');
    await drain(p.complete(REQ));
    expect(lines).toEqual([{ level: 'info', msg: 'llm call', obj: { provider: p.id, model: 'm-1', role: 'student', ms: expect.any(Number), ok: true, usage: (c.okEvents.at(-1) as { usage: unknown }).usage, stop: 'end' } }]);

    for (const respond of [() => sseResponse(c.midError), () => jsonResponse(c.errorBody(`Incorrect API key provided: ${KEY}`), 401), () => sseResponse(c.length)]) {
      const s = setup(respond, 'mentor');
      await drain(s.p.complete(REQ)).catch(() => {});
      lines.push(...s.lines);
    }
    expect(lines).toHaveLength(5);   // 성공 2·실패 2 = 호출당 1줄 + length 경고 1줄
    const failed = lines.filter(l => !(l.obj as { ok?: boolean }).ok && 'ok' in l.obj);
    expect(failed.map(l => l.msg)).toEqual(['llm call failed', 'llm call failed']);
    // #89: 실패 줄은 HTTP 상태(스트림 중 오류면 Gemini 의 숫자 code, 아니면 없음)와 공급자 오류 종류를 싣는다
    expect(failed.map(l => l.obj)).toEqual([
      { provider: p.id, model: 'm-1', role: 'mentor', ms: expect.any(Number), ok: false, code: 'provider_unavailable', status: p.id === 'gemini' ? 503 : undefined, kind: c.kinds.mid },
      { provider: p.id, model: 'm-1', role: 'mentor', ms: expect.any(Number), ok: false, code: 'provider_rejected', status: 401, kind: c.kinds.http },
    ]);
    const dump = JSON.stringify(lines);
    for (const secret of [KEY, 'SYSTEM-PROMPT-TEXT', 'USER-UTTERANCE', 'BOT-REPLY', '두 번째 발화', '반은', '이분의 일']) expect(dump).not.toContain(secret);
    // 공급자 메시지 본문·오류 본문 문자열도 넣지 않는다(Q9)
    for (const text of ['Incorrect API key', c.kinds.midMessage, 'stream error', '"error"', JSON.stringify(c.errorBody(`Incorrect API key provided: ${KEY}`))]) expect(dump).not.toContain(text);
  });

  it('listModels GETs the model list and returns ids; 401 → provider_rejected', async () => {
    const { p, calls } = setup(() => jsonResponse(c.models.json));
    expect(await p.listModels()).toEqual(c.models.ids);
    expect(calls).toEqual([{ url: c.models.url, method: 'GET', headers: expect.any(Object), body: undefined }]);
    const bad = setup(() => jsonResponse(c.errorBody('bad key'), 401)).p;
    await expect(bad.listModels()).rejects.toMatchObject({ code: 'provider_rejected', status: 401, retryable: false });
  });

  it('listModels: any 2xx is a valid key — 204, or 200 without a model list, returns [] (#55)', async () => {
    expect(await setup(() => new Response(null, { status: 204 })).p.listModels()).toEqual([]);
    expect(await setup(() => jsonResponse({})).p.listModels()).toEqual([]);
    expect(await setup(() => new Response('not json', { status: 200 })).p.listModels()).toEqual([]);
  });

  it('listModels never hangs: one 10 s signal — stalled 2xx body → [], stalled headers → retryable provider_unavailable', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(20));   // 운영값 10 s 를 20 ms 로 줄여 본다
    try {
      const stalled = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"data":[')); } }), { status: 200 });
      expect(await setup(() => stalled).p.listModels()).toEqual([]);
      expect(spy).toHaveBeenCalledWith(10_000);
      // 헤더가 오지 않는 fetch: 실제 fetch 처럼 signal 이 끊기면 그 reason 으로 거절한다.
      const noHeaders = ((_: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
      const p = c.make(KEY, { log: memLog().log, fetch: noHeaders });
      await expect(p.listModels()).rejects.toMatchObject({ name: 'AdapterError', code: 'provider_unavailable', retryable: true, message: 'timeout' });
    } finally { spy.mockRestore(); }
  });
});

// #55: 공급자 오류 글이 키를 되풀이해도, 300자로 자르기 전에 가려 키 앞부분이 남지 않는다.
const LONG_KEY = 'sk-ant-api03-' + Array.from({ length: 194 }, (_, i) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[i % 32]).join('');   // 207자
describe('provider text that echoes the key is masked before truncation (#55)', () => {
  const echo = `${'p'.repeat(110)}${LONG_KEY}${'q'.repeat(60)}`;
  const midError: Record<string, string> = {
    openai: sseText(`event: error\ndata: ${JSON.stringify({ type: 'error', code: 'invalid_api_key', message: echo })}`),
    anthropic: sseText(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: echo } })}`),
    gemini: sseText(`data: ${JSON.stringify({ error: { code: 400, message: echo, status: 'INVALID_ARGUMENT' } })}`),
  };
  it.each(Object.entries(CASES))('%s: HTTP error body (listModels and complete) and a mid-stream error', async (id, c) => {
    expect(leaksKey(echo.slice(0, 300), LONG_KEY)).toBe(true);   // 가리지 않고 자르면 새는 입력이다
    const make = (respond: () => Response) => c.make(LONG_KEY, { log: memLog().log, fetch: fakeFetch(respond).fetch });
    const http = () => jsonResponse(c.errorBody(echo), 401);
    const errs = [
      await make(http).listModels().catch((e: unknown) => e),
      await collect(make(http).complete(REQ)).catch((e: unknown) => e),
      await collect(make(() => sseResponse(midError[id]!)).complete(REQ)).catch((e: unknown) => e),
    ] as AdapterError[];
    for (const e of errs) {
      expect(e).toBeInstanceOf(AdapterError);
      expect(e.message).toContain('ppp');
      expect(e.message.length).toBeLessThanOrEqual(300);
      expect(leaksKey(e.message, LONG_KEY)).toBe(false);
    }
  });
});

describe('mid-stream error shapes without a numeric code (Q7)', () => {
  const fail = (make: Case['make'], text: string) => collect(make(KEY, { log: memLog().log, fetch: fakeFetch(() => sseResponse(text)).fetch }).complete(REQ)).catch((e: unknown) => e);
  it('gemini status string: PERMISSION_DENIED → rejected; RESOURCE_EXHAUSTED → unavailable, retryable', async () => {
    expect(await fail(geminiProvider, sseText(`data: {"error":{"message":"denied","status":"PERMISSION_DENIED"}}`))).toMatchObject({ code: 'provider_rejected', retryable: false });
    expect(await fail(geminiProvider, sseText(`data: {"error":{"message":"quota","status":"RESOURCE_EXHAUSTED"}}`))).toMatchObject({ code: 'provider_unavailable', retryable: true });
  });
  it('openai response.failed: invalid_prompt → rejected; server_error → unavailable, retryable', async () => {
    const failed = (code: string) => sseText(`event: response.failed
data: {"type":"response.failed","sequence_number":1,"response":{"id":"resp_1","status":"failed","error":{"code":"${code}","message":"x"}}}`);
    expect(await fail(openaiProvider, failed('invalid_prompt'))).toMatchObject({ code: 'provider_rejected', retryable: false });
    expect(await fail(openaiProvider, failed('server_error'))).toMatchObject({ code: 'provider_unavailable', retryable: true });
  });
});

// #89: 결제·지출·한도 소진은 429 여도 재시도해도 소용없다 → provider_rejected. 그 밖의 429·5xx 는 그대로 재시도 가능. 공급자별 사실은 docs/research/llm-providers-2026-10.md.
describe('provider error kinds: billing/quota exhaustion is rejected, rate limits stay retryable (#89)', () => {
  const http = (make: Case['make'], json: unknown, status: number) =>
    collect(make(KEY, { log: memLog().log, fetch: fakeFetch(() => jsonResponse(json, status)).fetch }).complete(REQ)).catch((e: unknown) => e);
  const mid = (make: Case['make'], text: string) =>
    collect(make(KEY, { log: memLog().log, fetch: fakeFetch(() => sseResponse(text)).fetch }).complete(REQ)).catch((e: unknown) => e);
  const QUOTA_CODES = ['credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded'];

  it('the billing/quota kind set is the documented OpenAI set', () => {
    expect([...QUOTA_KINDS].sort()).toEqual(['insufficient_quota', ...QUOTA_CODES].sort());
  });

  it.each(QUOTA_CODES)('openai 429 insufficient_quota / %s → provider_rejected, not retryable, kind = code', async code => {
    const e = await http(openaiProvider, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', param: null, code } }, 429);
    expect(e).toBeInstanceOf(AdapterError);
    expect(e).toMatchObject({ provider: 'openai', code: 'provider_rejected', retryable: false, status: 429, kind: code });
  });

  it('openai 429 with type insufficient_quota and no code → provider_rejected, kind insufficient_quota', async () => {
    expect(await http(openaiProvider, { error: { message: 'quota', type: 'insufficient_quota', param: null, code: null } }, 429))
      .toMatchObject({ code: 'provider_rejected', retryable: false, status: 429, kind: 'insufficient_quota' });
    expect(await http(openaiProvider, { error: { message: 'quota', type: 'insufficient_quota' } }, 429))
      .toMatchObject({ code: 'provider_rejected', retryable: false, status: 429, kind: 'insufficient_quota' });
  });

  it('openai 429 rate_limit_error / slow_down → provider_unavailable, retryable, kind slow_down; 503 server_is_overloaded stays retryable', async () => {
    expect(await http(openaiProvider, { error: { message: 'slow down', type: 'rate_limit_error', param: null, code: 'slow_down' } }, 429))
      .toMatchObject({ code: 'provider_unavailable', retryable: true, status: 429, kind: 'slow_down' });
    expect(await http(openaiProvider, { error: { message: 'busy', type: 'service_unavailable_error', param: null, code: 'server_is_overloaded' } }, 503))
      .toMatchObject({ code: 'provider_unavailable', retryable: true, status: 503, kind: 'server_is_overloaded' });
  });

  it('anthropic 402 billing_error → rejected; 429 rate_limit_error → unavailable, retryable; 529 overloaded_error → unavailable, retryable', async () => {
    const body = (type: string) => ({ type: 'error', error: { type, message: 'x' }, request_id: 'req_1' });
    expect(await http(anthropicProvider, body('billing_error'), 402)).toMatchObject({ code: 'provider_rejected', retryable: false, status: 402, kind: 'billing_error' });
    expect(await http(anthropicProvider, body('rate_limit_error'), 429)).toMatchObject({ code: 'provider_unavailable', retryable: true, status: 429, kind: 'rate_limit_error' });
    expect(await http(anthropicProvider, body('overloaded_error'), 529)).toMatchObject({ code: 'provider_unavailable', retryable: true, status: 529, kind: 'overloaded_error' });
  });

  it('gemini 429 RESOURCE_EXHAUSTED → unavailable, retryable; 403 PERMISSION_DENIED → rejected; a mid-stream numeric 429 carries the kind', async () => {
    const body = (code: number, status: string) => ({ error: { code, message: 'x', status } });
    expect(await http(geminiProvider, body(429, 'RESOURCE_EXHAUSTED'), 429)).toMatchObject({ code: 'provider_unavailable', retryable: true, status: 429, kind: 'RESOURCE_EXHAUSTED' });
    expect(await http(geminiProvider, body(403, 'PERMISSION_DENIED'), 403)).toMatchObject({ code: 'provider_rejected', retryable: false, status: 403, kind: 'PERMISSION_DENIED' });
    expect(await mid(geminiProvider, sseText(`data: {"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}`)))
      .toMatchObject({ code: 'provider_unavailable', retryable: true, status: 429, kind: 'RESOURCE_EXHAUSTED' });
  });

  it.each(['insufficient_quota', ...QUOTA_CODES])('openai mid-stream %s (response.failed and error event) → rejected, not retryable', async code => {
    const failed = sseText(`event: response.failed
data: {"type":"response.failed","sequence_number":1,"response":{"id":"resp_1","status":"failed","error":{"code":"${code}","message":"quota"}}}`);
    const error = sseText(`event: error
data: {"type":"error","sequence_number":1,"code":"${code}","message":"quota","param":null}`);
    for (const text of [failed, error]) expect(await mid(openaiProvider, text)).toMatchObject({ code: 'provider_rejected', retryable: false, kind: code });
  });
});

describe('anthropic max_tokens', () => {
  it('is 1024 for student and mentor, 2048 for analysis (adapter option, not in CompleteRequest)', async () => {
    const tokens = [];
    for (const role of ['student', 'mentor', 'analysis', undefined] as const) {
      const f = fakeFetch(() => sseResponse(ANTHROPIC_OK));
      await drain(anthropicProvider(KEY, { log: memLog().log, fetch: f.fetch, role }).complete(REQ));
      tokens.push((f.calls[0]!.body as { max_tokens: number }).max_tokens);
    }
    expect(tokens).toEqual([1024, 1024, 2048, 1024]);
  });
});

describe('providersFor', () => {
  it('builds the adapter for each real provider id', () => {
    const log = memLog().log;
    expect((['openai', 'anthropic', 'gemini'] as const).map(id => providersFor(id, KEY, { log, role: 'student' }).id)).toEqual(['openai', 'anthropic', 'gemini']);
  });
});
