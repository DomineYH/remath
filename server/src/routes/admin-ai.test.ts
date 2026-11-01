// 관리자 키 저장의 거절 로그(#89): listModels 가 던진 AdapterError 의 공급자 오류 종류가 'ai key rejected by provider' 로그에 남고,
// 응답 details 는 지금처럼 status·마스킹된 message 뿐이다. 키 확인 프로브(#94): listModels 성공 뒤 고른 모델로 최소 호출 1회 —
// provider_rejected = 저장 거부, provider_unavailable = 저장 + 'ai key probe inconclusive'. 핸들러를 직접 부른다(라우트·인증 전체는 admin-reads.test.ts).
import { readFileSync } from 'node:fs';
import * as S from '@remath/shared';
import { AdapterError, type CompleteRequest, type StreamEvent } from '@remath/shared/engine';
import { describe, expect, it } from 'vitest';
import type { Deps } from '../app.ts';
import { loadConfig } from '../config.ts';
import { ApiFail } from '../errors.ts';
import { anthropicProvider } from '../providers/anthropic.ts';
import { fakeFetch, jsonResponse, leaksKey, sseResponse, sseText } from '../providers/testkit.ts';
import type { ProvidersFor } from '../providers/types.ts';
import { adminAiHandlers, PROBE_MAX_OUTPUT_TOKENS } from './admin-ai.ts';

const ROOT = new URL('../../../', import.meta.url);
const SECRET = Buffer.alloc(32, 9).toString('base64');
const config = loadConfig({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'k', MOCK_LLM: '0', KEY_VAULT_SECRET: SECRET }, p => readFileSync(new URL(p, ROOT), 'utf8'));
const ANT = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123WXYZ';
const OA = 'sk-proj-' + 'abcdefghijklmnopqrstuvwxyz0123QRST';
const GG = 'AIza' + 'Syabcdefghijklmnopqrstuvwxyz0123UVW';
const PROMPT = 'Reply with the single word OK';
type Row = { role: string; key_source: string; provider: string | null; key_masked: string | null; key_added_at: string | null; model: string | null; effort: string | null };
const row = (role: string): Row => ({ role, key_source: role === 'student' ? 'own' : 'student', provider: null, key_masked: null, key_added_at: null, model: null, effort: null });

/** ai_settings 읽기·upsert 와 audit_log insert 를 기록하는 가짜 DB. upsert 는 key_ciphertext 를 뺀 행을 돌려준다(AI_COLS). */
function fakeDb(rows: Row[]) {
  const upserts: Record<string, unknown>[][] = [], audits: unknown[] = [];
  const db = {
    from: (table: string) => table === 'audit_log'
      ? { insert: async (e: unknown) => { audits.push(e); return { error: null }; } }
      : {
          select: async () => ({ data: rows, error: null }),
          upsert: (write: Record<string, unknown>[]) => { upserts.push(write); return { select: async () => ({ data: write.map(({ key_ciphertext: _, ...x }) => x), error: null }) }; },
        },
  };
  return { db, upserts, audits };
}

/** listModels·complete 를 흉내 내는 가짜 providersFor. probe = 'done' | 'length' | 던질 오류. 호출 기록을 남긴다. */
function fakeProviders(listFail?: () => unknown, probe: 'done' | 'length' | (() => unknown) = 'done') {
  const calls = { providersFor: 0, listModels: 0, complete: [] as CompleteRequest[] };
  const providersFor: ProvidersFor = provider => {
    calls.providersFor++;
    return {
      id: provider,
      listModels: async () => { calls.listModels++; if (listFail) throw listFail(); return []; },
      complete: req => {
        calls.complete.push(req);
        return (async function* (): AsyncGenerator<StreamEvent> {
          if (typeof probe === 'function') throw probe();
          yield { type: 'delta', text: 'OK' };
          yield { type: 'done', model: req.model, stopReason: probe === 'length' ? 'length' : 'end' };
        })();
      },
    };
  };
  return { providersFor, calls };
}

interface Put { providersFor: ProvidersFor; role?: string; body?: Record<string, unknown>; mock?: boolean; rows?: Row[] }
/** PUT 핸들러 1회. warn = warn 줄({obj,msg}), all = 모든 로그 줄(누출 검사용). 성공이면 res, 실패면 err. */
async function put({ providersFor, role = 'student', body = { key_source: 'own', api_key: ANT, model: 'claude-haiku-5-5', effort: 'low' }, mock = false, rows = ['student', 'mentor', 'analysis'].map(row) }: Put) {
  const warn: { obj: object; msg?: string }[] = [], all: unknown[] = [];
  const log = { warn: (obj: object, msg?: string) => { warn.push({ obj, msg }); all.push({ obj, msg }); }, info: (obj: object, msg?: string) => all.push({ obj, msg }), error: (obj: object, msg?: string) => all.push({ obj, msg }) };
  const f = fakeDb(rows);
  const cfg = mock ? loadConfig({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'k', MOCK_LLM: '1' }, p => readFileSync(new URL(p, ROOT), 'utf8')) : config;
  const h = adminAiHandlers({ db: f.db, config: cfg, now: () => new Date('2026-11-01T00:00:00Z'), providersFor } as unknown as Deps);
  const req = { params: { role }, body, log, auth: { user: { id: 'admin-1' } } };
  let res: unknown, err: ApiFail | undefined;
  try { res = await h['PUT /api/admin/ai/:role']!(req as never, {} as never); } catch (e) { err = e as ApiFail; }
  return { res, err, warn, all, upserts: f.upserts, audits: f.audits };
}

/** 거절 경로 전용(#89 테스트들): 거절이 아니거나 upsert 가 불리면 실패다. */
async function save(fail: () => unknown, providersFor: ProvidersFor = fakeProviders(fail).providersFor) {
  const r = await put({ providersFor });
  if (!r.err) throw new Error('expected a rejection');
  expect(r.upserts).toEqual([]);
  return { err: r.err, lines: r.warn };
}

describe('PUT /api/admin/ai/:role rejection log carries the provider error kind (#89)', () => {
  it('an AdapterError with kind → the warn line has kind; details stay { status, masked message } without the key', async () => {
    const { err, lines } = await save(() => new AdapterError('anthropic', 'provider_rejected', `402 Your credit balance is too low ${ANT}`, { status: 402, kind: 'billing_error' }));
    expect(err).toBeInstanceOf(ApiFail);
    expect(err.code).toBe('provider_rejected');
    expect(err.details).toEqual({ status: 402, message: `402 Your credit balance is too low ${S.maskKey(ANT)}` });
    expect(lines).toEqual([{ obj: { role: 'student', provider: 'anthropic', status: 402, kind: 'billing_error' }, msg: 'ai key rejected by provider' }]);
    const dump = JSON.stringify(lines);
    for (const text of [ANT, S.maskKey(ANT), 'credit balance']) expect(dump).not.toContain(text);
    expect(JSON.stringify(err.details)).not.toContain(ANT);
  });

  it('a kind the AdapterError refused (message-like) and a non-AdapterError leave kind out of the log', async () => {
    for (const fail of [
      () => new AdapterError('anthropic', 'provider_rejected', '429 x', { status: 429, kind: `quota exhausted for ${ANT}` }),
      () => Object.assign(new TypeError('fetch failed'), { kind: `raw ${ANT}` }),
    ]) {
      const { err, lines } = await save(fail);
      expect(err.code).toBe('provider_rejected');
      expect(lines).toHaveLength(1);
      expect((lines[0]!.obj as { kind?: string }).kind).toBeUndefined();
      expect(JSON.stringify(lines)).not.toContain(ANT);
    }
  });

  // #89 F1: 문자 검사를 통과하는 키 모양 종류(대소문자 섞임) — 생성자에서, 그리고 실제 어댑터 경로(주입 fetch)에서도 로그에 남지 않는다.
  it('a credential-shaped provider error kind leaves kind out of the log', async () => {
    const cred = 'AIzaSy' + 'X'.repeat(33);
    const viaAdapter: ProvidersFor = (_, key, o) => anthropicProvider(key, { ...o, fetch: fakeFetch(() => jsonResponse({ type: 'error', error: { type: cred, message: 'x' } }, 403)).fetch });
    for (const [fail, pf] of [
      [() => new AdapterError('gemini', 'provider_rejected', '403 x', { status: 403, kind: cred }), undefined],
      [() => { throw new Error('unused'); }, viaAdapter],
      [() => { throw new Error('unused'); }, ((_, key, o) => anthropicProvider(key, { ...o, fetch: fakeFetch(() => jsonResponse({ type: 'error', error: { type: ANT, message: 'x' } }, 403)).fetch })) as ProvidersFor],
    ] as const) {
      const { err, lines } = await save(fail, pf);
      expect(err.code).toBe('provider_rejected');
      expect(lines).toEqual([{ obj: { role: 'student', provider: 'anthropic', status: 403, kind: undefined }, msg: 'ai key rejected by provider' }]);
      const dump = JSON.stringify(lines);
      for (const text of [cred, ANT]) expect(dump).not.toContain(text);
    }
  });

  // #89 재리뷰 F1: 실제 어댑터 경로 — 문서 목록(LOGGED_KINDS)에 없는 종류는 키 조각·문구든 무엇이든 로그에 남지 않고, 목록의 종류는 남는다.
  it('through the real adapter: a wrapped key fragment or a message-shaped kind is not logged; a listed kind (billing_error) is', async () => {
    const via = (type: string, status: number): ProvidersFor => (_, key, o) => anthropicProvider(key, { ...o, fetch: fakeFetch(() => jsonResponse({ type: 'error', error: { type, message: 'x' } }, status)).fetch });
    for (const type of [`quota_${ANT.slice(8, 24)}_x`, `err_${ANT.slice(8, 24)}`, 'your_balance_is_empty']) {
      const { err, lines } = await save(() => { throw new Error('unused'); }, via(type, 403));
      expect(err.code).toBe('provider_rejected');
      expect(lines).toEqual([{ obj: { role: 'student', provider: 'anthropic', status: 403, kind: undefined }, msg: 'ai key rejected by provider' }]);
      const dump = JSON.stringify(lines);
      expect(dump).not.toContain(type);
      expect(leaksKey(dump, ANT)).toBe(false);
    }
    const { lines } = await save(() => { throw new Error('unused'); }, via('billing_error', 402));
    expect(lines).toEqual([{ obj: { role: 'student', provider: 'anthropic', status: 402, kind: 'billing_error' }, msg: 'ai key rejected by provider' }]);
  });
});

describe('PUT /api/admin/ai/:role key probe: one minimal paid call after listModels (#94)', () => {
  const rejected: [string, string, string, () => AdapterError][] = [
    ['openai 429 credit_balance_exhausted', OA, 'gpt-6.1-sol', () => new AdapterError('openai', 'provider_rejected', `429 You exceeded your current quota ${OA}`, { status: 429, kind: 'credit_balance_exhausted' })],
    ['anthropic 402 billing_error', ANT, 'claude-haiku-5-5', () => new AdapterError('anthropic', 'provider_rejected', `402 Your credit balance is too low ${ANT}`, { status: 402, kind: 'billing_error' })],
    ['gemini 403 PERMISSION_DENIED', GG, 'gemini-3.8-flash', () => new AdapterError('gemini', 'provider_rejected', `403 Permission denied for ${GG}`, { status: 403, kind: 'PERMISSION_DENIED' })],
    ['openai 404 model not accessible', OA, 'gpt-custom-typo', () => new AdapterError('openai', 'provider_rejected', `404 The model does not exist or you do not have access ${OA}`, { status: 404, kind: 'model_not_found' })],
  ];
  it.each(rejected)('a provider_rejected probe (%s) refuses the save: same details shape, no upsert, rejected log with kind', async (_, key, model, fail) => {
    const { providersFor, calls } = fakeProviders(undefined, fail);
    const { err, warn, all, upserts, audits } = await put({ providersFor, body: { key_source: 'own', api_key: key, model, effort: null } });
    const e = fail(), provider = S.detectProvider(key);
    expect(err).toBeInstanceOf(ApiFail);
    expect(err!.code).toBe('provider_rejected');
    expect(err!.details).toEqual({ status: e.status, message: e.message.replaceAll(key, S.maskKey(key)) });
    expect(upserts).toEqual([]);
    expect(audits).toEqual([]);
    expect([calls.listModels, calls.complete.length]).toEqual([1, 1]);
    expect(warn).toEqual([{ obj: { role: 'student', provider, status: e.status, kind: e.kind }, msg: 'ai key rejected by provider' }]);
    const dump = JSON.stringify(all);
    expect(leaksKey(dump, key)).toBe(false);
    expect(JSON.stringify(err!.details)).not.toContain(key);   // details 는 마스킹 값(접두어 포함)을 싣는다
    for (const text of [PROMPT, 'quota', 'credit balance', 'Permission denied', 'does not exist']) expect(dump).not.toContain(text);
  });

  const unavailable: [string, () => AdapterError, number | null, string | undefined][] = [
    ['429 without a quota kind', () => new AdapterError('anthropic', 'provider_unavailable', '429 rate limited', { status: 429, retryable: true }), 429, undefined],
    ['503', () => new AdapterError('anthropic', 'provider_unavailable', '503 overloaded', { status: 503, retryable: true, kind: 'api_error' }), 503, 'api_error'],
    ['timeout', () => new AdapterError('anthropic', 'provider_unavailable', 'timeout', { retryable: true }), null, undefined],
  ];
  it.each(unavailable)('a provider_unavailable probe (%s) saves the sealed key and logs one inconclusive line', async (_, fail, status, kind) => {
    const { providersFor, calls } = fakeProviders(undefined, fail);
    const { res, err, warn, all, upserts, audits } = await put({ providersFor });
    expect(err).toBeUndefined();
    expect(res).toMatchObject({ role: 'student', key_source: 'own', provider: 'anthropic', key_masked: S.maskKey(ANT), model: 'claude-haiku-5-5', effort: 'low' });
    expect(upserts).toHaveLength(1);
    const sealed = upserts[0]![0]!.key_ciphertext as string;
    expect(typeof sealed).toBe('string');
    expect(sealed).not.toContain(ANT);
    expect(audits).toHaveLength(1);
    expect([calls.listModels, calls.complete.length]).toEqual([1, 1]);
    expect(warn).toEqual([{ obj: { role: 'student', provider: 'anthropic', status, kind }, msg: 'ai key probe inconclusive' }]);
    const dump = JSON.stringify([all, res, audits]);
    expect(leaksKey(dump, ANT)).toBe(false);
    expect(dump).not.toContain(PROMPT);
  });

  it.each(['done', 'length'] as const)('a probe that ends with done (stop %s) saves without a warning', async probe => {
    const { providersFor, calls } = fakeProviders(undefined, probe);
    const { res, err, warn, upserts } = await put({ providersFor });
    expect(err).toBeUndefined();
    expect(res).toMatchObject({ role: 'student', provider: 'anthropic', key_masked: S.maskKey(ANT) });
    expect(upserts).toHaveLength(1);
    expect(typeof upserts[0]![0]!.key_ciphertext).toBe('string');
    expect(calls.complete).toHaveLength(1);
    expect(warn).toEqual([]);
  });

  it('the probe request: the body model, the constant output cap, no effort, a signal', async () => {
    const { providersFor, calls } = fakeProviders();
    await put({ providersFor, body: { key_source: 'own', api_key: ANT, model: 'claude-haiku-5-5', effort: 'low' } });
    expect(calls.complete).toHaveLength(1);
    const req = calls.complete[0]!;
    expect(PROBE_MAX_OUTPUT_TOKENS).toBe(16);
    expect(req.model).toBe('claude-haiku-5-5');
    expect(req.maxOutputTokens).toBe(PROBE_MAX_OUTPUT_TOKENS);
    expect('effort' in req).toBe(false);
    expect(req.signal).toBeInstanceOf(AbortSignal);
    expect(req.messages).toEqual([{ role: 'user', content: 'OK' }]);
  });

  it('a failed listModels never sends the probe', async () => {
    const { providersFor, calls } = fakeProviders(() => new AdapterError('anthropic', 'provider_rejected', '401 invalid x-api-key', { status: 401, kind: 'authentication_error' }));
    const { err, upserts } = await put({ providersFor });
    expect(err!.code).toBe('provider_rejected');
    expect(upserts).toEqual([]);
    expect([calls.listModels, calls.complete.length]).toEqual([1, 0]);
  });

  it('an unexpected (non-AdapterError) probe failure is thrown as is and nothing is saved', async () => {
    const boom = new TypeError('adapter bug');
    const { providersFor } = fakeProviders(undefined, () => boom);
    const { err, upserts, warn } = await put({ providersFor });
    expect(err).toBe(boom);
    expect(upserts).toEqual([]);
    expect(warn).toEqual([]);
  });

  it('shared-key saves, saves without a new key, and MOCK_LLM=1 call neither listModels nor complete', async () => {
    const owned = ['student', 'mentor', 'analysis'].map(row).map(r => r.role === 'student' ? { ...r, provider: 'anthropic', key_masked: S.maskKey(ANT), key_added_at: '2026-10-01T00:00:00.000Z', model: 'claude-haiku-5-5' } : r);
    for (const p of [
      { role: 'mentor', body: { key_source: 'student', model: 'claude-haiku-5-5', effort: null }, rows: owned },
      { role: 'student', body: { key_source: 'own', model: 'claude-haiku-5-5', effort: null }, rows: owned },
      { mock: true },
    ] as Omit<Put, 'providersFor'>[]) {
      const { providersFor, calls } = fakeProviders();
      const { err, upserts } = await put({ ...p, providersFor });
      expect(err).toBeUndefined();
      expect(upserts).toHaveLength(1);
      expect(calls).toEqual({ providersFor: 0, listModels: 0, complete: [] });
    }
  });

  // 실제 어댑터 경로(주입 fetch): 요청 본문에 상한이 실리고, 로그(llm call 줄 포함)·응답에 키·프롬프트·공급자 문구가 없다.
  const MODELS = () => jsonResponse({ data: [], has_more: false });
  const ANT_OK = sseText(
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":12,"output_tokens":1}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  );
  const viaAdapter = (probe: () => Response) => {
    const f = fakeFetch(() => (f.calls.length === 1 ? MODELS() : probe()));
    const providersFor: ProvidersFor = (_, key, o) => anthropicProvider(key, { ...o, fetch: f.fetch });
    return { providersFor, calls: f.calls };
  };

  it('through the real adapter: success sends max_tokens 16 without effort and logs one llm call line without prompt text', async () => {
    const { providersFor, calls } = viaAdapter(() => sseResponse(ANT_OK));
    const { res, err, warn, all, upserts } = await put({ providersFor });
    expect(err).toBeUndefined();
    expect(upserts).toHaveLength(1);
    expect(calls.map(c => c.method)).toEqual(['GET', 'POST']);
    const sent = calls[1]!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 16 });
    expect(sent).not.toHaveProperty('output_config');
    expect(warn).toEqual([]);
    expect(all).toEqual([{ obj: expect.objectContaining({ provider: 'anthropic', model: 'claude-haiku-5-5', role: 'student', ok: true }), msg: 'llm call' }]);
    const dump = JSON.stringify([all, res]);
    expect(leaksKey(dump, ANT)).toBe(false);
    expect(dump).not.toContain(PROMPT);
  });

  it('through the real adapter: a 402 billing_error probe is refused and an overloaded 529 probe saves; no key, prompt or provider text leaks', async () => {
    const billing = viaAdapter(() => jsonResponse({ type: 'error', error: { type: 'billing_error', message: `Your credit balance is too low ${ANT}` } }, 402));
    const r1 = await put({ providersFor: billing.providersFor });
    expect(r1.err!.code).toBe('provider_rejected');
    expect(r1.err!.details).toEqual({ status: 402, message: `402 Your credit balance is too low ${S.maskKey(ANT)}` });
    expect(r1.upserts).toEqual([]);
    expect(r1.warn.at(-1)).toEqual({ obj: { role: 'student', provider: 'anthropic', status: 402, kind: 'billing_error' }, msg: 'ai key rejected by provider' });

    const overloaded = viaAdapter(() => jsonResponse({ type: 'error', error: { type: 'overloaded_error', message: `Overloaded ${ANT}` } }, 529));
    const r2 = await put({ providersFor: overloaded.providersFor });
    expect(r2.err).toBeUndefined();
    expect(r2.upserts).toHaveLength(1);
    expect(r2.warn.at(-1)).toEqual({ obj: { role: 'student', provider: 'anthropic', status: 529, kind: 'overloaded_error' }, msg: 'ai key probe inconclusive' });
    expect(r2.warn.filter(l => l.msg === 'ai key rejected by provider')).toEqual([]);

    for (const r of [r1, r2]) {
      const dump = JSON.stringify([r.all, r.res, r.audits]);
      expect(leaksKey(dump, ANT)).toBe(false);
      for (const text of [PROMPT, 'credit balance', 'Overloaded']) expect(dump).not.toContain(text);
      expect(leaksKey(JSON.stringify(r.err?.details ?? null), ANT)).toBe(false);
    }
  });
});
