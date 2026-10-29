// test:http (Q30): saving an AI key on a MOCK_LLM=0 server calls the real provider's listModels once. A fake key → provider_rejected, nothing saved.
// MOCK_LLM comes from the same ENV_FILE the server under test reads; any other value skips (a mock server never calls a provider).
import { describe, expect, it } from 'vitest';
import { ADMIN_PW, target } from '../../../client/src/api/seam.ts';
import type { ApiError } from '../../../client/src/api/types.ts';

describe.skipIf(process.env.MOCK_LLM !== '0')('AI settings save on a real-provider server (Q5, Q30)', () => {
  it('a fake OpenAI key → 502 provider_rejected and the settings are unchanged', async () => {
    const admin = target().api('admin');
    await admin.adminLogin({ nickname: 'admin', password: ADMIN_PW });
    const before = await admin.getAiSettings();
    const err = await admin.updateAiRole('student', { key_source: 'own', api_key: 'sk-proj-remathFakeKey000000000000', model: 'gpt-5.5', effort: null })
      .then(() => { throw new Error('saved a fake key'); }, (e: ApiError) => e);
    expect([err.status, err.code]).toEqual([502, 'provider_rejected']);
    expect(await admin.getAiSettings()).toEqual(before);
  });
});
