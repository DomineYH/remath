// 어댑터 3종 픽스처 테스트(#56). 픽스처 = docs/research/llm-providers-2026-10.md 의 실제 응답 형태를 손으로 적은 SSE.
import { AdapterError, collect, type CompleteRequest, type Provider, type Role, type StreamEvent } from '@remath/shared/engine';
import { describe, expect, it, vi } from 'vitest';
import { anthropicProvider } from './anthropic.ts';
import { geminiProvider } from './gemini.ts';
import { openaiProvider } from './openai.ts';
import { providersFor } from './index.ts';
import type { AdapterOpts } from './call.ts';
import { fakeFetch, jsonResponse, memLog, sseResponse, sseText } from './testkit.ts';

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
    expect(lines.filter(l => !(l.obj as { ok?: boolean }).ok && 'ok' in l.obj).map(l => l.obj)).toEqual([
      expect.objectContaining({ ok: false, code: 'provider_unavailable' }), expect.objectContaining({ ok: false, code: 'provider_rejected' }),
    ]);
    const dump = JSON.stringify(lines);
    for (const secret of [KEY, 'SYSTEM-PROMPT-TEXT', 'USER-UTTERANCE', 'BOT-REPLY', '두 번째 발화', '반은', '이분의 일']) expect(dump).not.toContain(secret);
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
