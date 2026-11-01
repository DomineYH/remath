// 관리자 키 저장의 거절 로그(#89): listModels 가 던진 AdapterError 의 공급자 오류 종류가 'ai key rejected by provider' 로그에 남고,
// 응답 details 는 지금처럼 status·마스킹된 message 뿐이다. 핸들러를 직접 부른다(라우트·인증 전체는 admin-reads.test.ts).
import { readFileSync } from 'node:fs';
import * as S from '@remath/shared';
import { AdapterError } from '@remath/shared/engine';
import { describe, expect, it } from 'vitest';
import type { Deps } from '../app.ts';
import { loadConfig } from '../config.ts';
import { ApiFail } from '../errors.ts';
import type { ProvidersFor } from '../providers/types.ts';
import { adminAiHandlers } from './admin-ai.ts';

const ROOT = new URL('../../../', import.meta.url);
const SECRET = Buffer.alloc(32, 9).toString('base64');
const config = loadConfig({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'k', MOCK_LLM: '0', KEY_VAULT_SECRET: SECRET }, p => readFileSync(new URL(p, ROOT), 'utf8'));
const ANT = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123WXYZ';
const row = (role: string) => ({ role, key_source: role === 'student' ? 'own' : 'student', provider: null, key_masked: null, key_added_at: null, model: null, effort: null });

/** ai_settings 읽기만 있는 가짜 DB. 거절 경로는 쓰기 전에 끝나므로 upsert 가 불리면 실패다. */
const db = { from: () => ({ select: async () => ({ data: ['student', 'mentor', 'analysis'].map(row), error: null }), upsert: () => { throw new Error('must not save a rejected key'); } }) };

async function save(fail: () => unknown) {
  const providersFor: ProvidersFor = provider => ({ id: provider, complete: () => { throw new Error('unused'); }, listModels: async () => { throw fail(); } });
  const lines: { obj: object; msg?: string }[] = [];
  const log = { warn: (obj: object, msg?: string) => lines.push({ obj, msg }), info: () => {}, error: () => {} };
  const h = adminAiHandlers({ db, config, now: () => new Date('2026-11-01T00:00:00Z'), providersFor } as unknown as Deps);
  const req = { params: { role: 'student' }, body: { key_source: 'own', api_key: ANT, model: 'claude-haiku-5-5', effort: 'low' }, log };
  const err = await h['PUT /api/admin/ai/:role']!(req as never, {} as never).then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e);
  return { err: err as ApiFail, lines };
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
});
