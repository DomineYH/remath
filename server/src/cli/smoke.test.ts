// deploy.sh 4단계 스모크의 판정. Data API 는 가짜 fetch 로 바꾼다; 실 DB 는 수동(T-4).
import { describe, expect, it } from 'vitest';
import { smoke } from './smoke.ts';

describe('deploy smoke (H-29 4, D-17)', () => {
  const SLUGS = ['gabriel', 'hajun', 'jiwoo', 'noah', 'seoyeon'];
  const ids = SLUGS.map((_, i) => ({ id: `s${i}` }));
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const denied = () => json(401, { code: '42501', message: 'permission denied for table scenarios' });

  /** 경로 → 응답. anon 키 요청은 `anon:` 접두어로 구분한다. */
  function fakeFetch(routes: Record<string, () => Response>) {
    const seen: { url: string; key: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>).apikey;
      seen.push({ url, key });
      const path = (init.method === 'HEAD' ? 'HEAD ' : '') + (key === 'anon' ? 'anon:' : '') + url.slice('https://p.supabase.co/rest/v1/'.length);
      if (!routes[path]) throw new Error(`unexpected ${path}`);
      return routes[path]();
    }) as typeof fetch;
    return { f, seen };
  }
  const healthy = {
    'users?select=id&role=eq.admin': () => json(200, [{ id: 'a' }]),
    'ai_settings?select=role': () => json(200, [{ role: 'student' }, { role: 'mentor' }, { role: 'analysis' }]),
    'scenarios?select=id&status=eq.published&slug=in.(gabriel,hajun,jiwoo,noah,seoyeon)': () => json(200, ids),
    'scenario_translations?select=id&scenario_id=in.(s0,s1,s2,s3,s4)': () => json(200, Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` }))),
    'scenario_translations?select=id&scenario_id=in.(s0,s1,s2,s3)': () => json(200, Array.from({ length: 8 }, (_, i) => ({ id: `t${i}` }))),
    'anon:scenarios?select=internal': denied,
  };
  const run = (routes: Record<string, () => Response>, samples?: string[], anonKey = 'anon') =>
    smoke({ url: 'https://p.supabase.co', serviceKey: 'service', anonKey, samples, fetch: fakeFetch(routes).f });
  const failed = async (p: Promise<{ name: string; ok: boolean }[]>) => (await p).filter(c => !c.ok).map(c => c.name);

  it('passes on a seeded project, with and without samples', async () => {
    expect(await failed(run(healthy, SLUGS))).toEqual([]);
    const checks = await run(healthy);
    expect(checks.map(c => c.name)).toEqual(['admin user', 'ai_settings', 'anon denied scenarios.internal']);
    expect(checks.every(c => c.ok)).toBe(true);
  });

  it('row counts use the service key; the denial check uses the anon key', async () => {
    const { f, seen } = fakeFetch(healthy);
    await smoke({ url: 'https://p.supabase.co', serviceKey: 'service', anonKey: 'anon', samples: SLUGS, fetch: f });
    expect(seen.map(s => s.key)).toEqual(['service', 'service', 'service', 'service', 'anon']);
  });

  it('fails on wrong row counts', async () => {
    expect(await failed(run({ ...healthy, 'users?select=id&role=eq.admin': () => json(200, []) }, SLUGS))).toEqual(['admin user']);
    expect(await failed(run({ ...healthy, 'ai_settings?select=role': () => json(200, [{ role: 'student' }]) }))).toEqual(['ai_settings']);
    expect(await failed(run({ ...healthy, 'scenarios?select=id&status=eq.published&slug=in.(gabriel,hajun,jiwoo,noah,seoyeon)': () => json(200, ids.slice(0, 4)) }, SLUGS)))
      .toEqual(['sample scenarios published', 'sample translations']);
  });

  it('fails when the anon key can read scenarios (e.g. the service key passed as SUPABASE_ANON_KEY)', async () => {
    expect(await failed(run({ ...healthy, 'anon:scenarios?select=internal': () => json(200, [{ internal: {} }]) }))).toEqual(['anon denied scenarios.internal']);
  });

  it('a 401 that is not a DB permission denial (invalid API key) does not count as denied', async () => {
    expect(await failed(run({ ...healthy, 'anon:scenarios?select=internal': () => json(401, { message: 'Invalid API key' }) }))).toEqual(['anon denied scenarios.internal']);
  });

  it('restore mode: exact per-table counts (HEAD, Prefer count=exact, so no max-rows cap) instead of the seed checks', async () => {
    const range = (r: string) => () => new Response(null, { status: 200, headers: { 'content-range': r } });
    const { f, seen } = fakeFetch({
      'HEAD users?select=*': range('0-0/2'), 'HEAD turns?select=*': range('0-0/1500'), 'HEAD groups?select=*': range('*/0'),
      'HEAD audit_log?select=*': () => json(500, {}), 'anon:scenarios?select=internal': denied,
    });
    const checks = await smoke({ url: 'https://p.supabase.co', serviceKey: 'service', anonKey: 'anon', fetch: f, counts: { users: 2, turns: 1500, groups: 1, audit_log: 0 } });
    expect(checks).toEqual([
      { name: 'rows users', ok: true, detail: '2 rows, want 2' },
      { name: 'rows turns', ok: true, detail: '1500 rows, want 1500' },
      { name: 'rows groups', ok: false, detail: '0 rows, want 1' },
      { name: 'rows audit_log', ok: false, detail: 'HTTP 500' },
      { name: 'anon denied scenarios.internal', ok: true, detail: 'HTTP 401 code 42501' },
    ]);
    expect(seen.map(s => s.key)).toEqual(['service', 'service', 'service', 'service', 'anon']);
  });

  it('HTTP errors and network failures are FAIL, not crashes', async () => {
    const checks = await run({ ...healthy, 'users?select=id&role=eq.admin': () => json(500, {}), 'anon:scenarios?select=internal': () => { throw new TypeError('fetch failed'); } });
    expect(checks.filter(c => !c.ok)).toEqual([
      { name: 'admin user', ok: false, detail: 'HTTP 500' },
      { name: 'anon denied scenarios.internal', ok: false, detail: 'fetch failed' },
    ]);
  });
});
