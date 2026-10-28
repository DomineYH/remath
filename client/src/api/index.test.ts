// The HTTP↔mock switch (A-3): one env key decides, and only a mock build carries the mock module.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_ROUTES } from './types.ts';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('createApi', () => {
  it('VITE_MOCK_API=1 → mock (fresh store: not logged in)', async () => {
    vi.stubEnv('VITE_MOCK_API', '1');
    vi.resetModules();
    const { ApiError, createApi } = await import('./index.ts');
    const err = await createApi('teacher').me().catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
  });
  it('unset → HTTP implementation with all 38 methods', async () => {
    const { createApi } = await import('./index.ts');
    const api = createApi('teacher', {});
    expect(Object.keys(api).sort()).toEqual(Object.keys(API_ROUTES).sort());
  });
  it('mock requested in a non-mock build → clear error', async () => {
    const { createApi } = await import('./index.ts');
    expect(() => createApi('teacher', { VITE_MOCK_API: '1' })).toThrow(/mock API not bundled/);
  });
});
