// deploy.sh --new 1단계 (H-29 1, O-4): Management API 를 가짜 fetch 로. 실 API 는 G3 1단계(수동).
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newProject, writeNewEnv } from './new-project.ts';

const TOKEN = 'sbp_secret_token_never_print';
const REF = 'abcdefghijklmnopqrst';
const ANON = 'eyJ.anon.jwt', SERVICE = 'eyJ.service.jwt';
const POOLER = [
  { identifier: 'replica', database_type: 'READ_REPLICA', db_user: 'postgres.replica', db_host: 'replica.pooler.supabase.com', db_port: 6543, db_name: 'postgres', pool_mode: 'transaction' },
  { identifier: REF, database_type: 'PRIMARY', db_user: `postgres.${REF}`, db_host: 'aws-1-ap-northeast-2.pooler.supabase.com', db_port: 6543, db_name: 'postgres', pool_mode: 'transaction' },
];
const KEYS = [
  { name: 'anon', type: 'legacy', api_key: ANON },
  { name: 'service_role', type: 'legacy', api_key: SERVICE },
  { name: 'default', type: 'publishable', api_key: 'sb_publishable_x' },
];

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
/** 경로(method + path)마다 응답 큐. 큐의 마지막 응답은 계속 반복된다. */
function fake(routes: Record<string, Reply[]>) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', u = new URL(url);
    calls.push({ method, url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined });
    const q = routes[`${method} ${u.pathname}`];
    if (!q) throw new Error(`unexpected ${method} ${url}`);
    const r = q.length > 1 ? q.shift()! : q[0];
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return { f, calls };
}
const ok = (body: unknown): Reply => ({ status: 200, body });
const happy = (extra: Record<string, Reply[]> = {}) => ({
  'POST /v1/projects': [{ status: 201, body: { ref: REF, status: 'COMING_UP' } }],
  [`GET /v1/projects/${REF}`]: [ok({ ref: REF, status: 'COMING_UP' }), ok({ ref: REF, status: 'COMING_UP' }), ok({ ref: REF, status: 'ACTIVE_HEALTHY' })],
  [`GET /v1/projects/${REF}/api-keys`]: [ok(KEYS)],
  [`GET /v1/projects/${REF}/config/database/pooler`]: [ok(POOLER)],
  ...extra,
});

function run(routes: Record<string, Reply[]>, o: Partial<Parameters<typeof newProject>[0]> = {}) {
  const { f, calls } = fake(routes);
  let t = 0;
  const slept: number[] = [], log: string[] = [];
  const p = newProject({
    token: TOKEN, org: 'my-org', region: 'ap-northeast-2', dbPass: 'p@ss:w/rd?#%&!\'()* ', name: 'remath-test',
    fetch: f, now: () => t, sleep: async ms => { slept.push(ms); t += ms; }, timeoutMs: 600_000, intervalMs: 10_000, log: s => log.push(s), ...o,
  });
  return { p, calls, slept, log };
}

describe('db:new-project (H-29 1, O-4)', () => {
  it('creates the project with the documented body and bearer token, polls until ACTIVE_HEALTHY, then reads keys and the pooler', async () => {
    const r = run(happy());
    const v = await r.p;
    expect(r.calls.map(c => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.supabase.com/v1/projects',
      `GET https://api.supabase.com/v1/projects/${REF}`, `GET https://api.supabase.com/v1/projects/${REF}`, `GET https://api.supabase.com/v1/projects/${REF}`,
      `GET https://api.supabase.com/v1/projects/${REF}/api-keys?reveal=true`,
      `GET https://api.supabase.com/v1/projects/${REF}/config/database/pooler`,
    ]);
    expect(r.calls[0].body).toEqual({ name: 'remath-test', organization_slug: 'my-org', db_pass: 'p@ss:w/rd?#%&!\'()* ', region_selection: { type: 'specific', code: 'ap-northeast-2' } });
    for (const c of r.calls) expect(c.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(r.slept).toEqual([10_000, 10_000]);
    expect(v).toEqual({
      SUPABASE_URL: `https://${REF}.supabase.co`, SUPABASE_SERVICE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON,
      // session pooler(5432), 비밀번호는 글자마다 퍼센트 인코딩
      SUPABASE_DB_URL: `postgresql://postgres.${REF}:p%40ss%3Aw%2Frd%3F%23%25%26%21%27%28%29%2A%20@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require`,
    });
    expect(r.log.join('\n')).toContain(REF);
    expect(r.log.join('\n')).not.toContain(TOKEN);
  });

  it('a timeout fails with the ref and leaves the project (no DELETE, no PATCH)', async () => {
    const r = run(happy({ [`GET /v1/projects/${REF}`]: [ok({ ref: REF, status: 'COMING_UP' })] }), { timeoutMs: 60_000 });
    await expect(r.p).rejects.toThrow(new RegExp(`${REF}.*not ACTIVE_HEALTHY within 60s.*left in place, delete it by hand`));
    expect(r.calls.every(c => c.method === 'GET' || c.url.endsWith('/v1/projects'))).toBe(true);
  });

  /** 응답(헤더)이나 본문이 영영 오지 않는 fetch. undici 처럼 init.signal 이 끊으면 그 reason 으로 실패한다. */
  const stalled = (o: { body?: boolean } = {}) => (async (url: string, init: RequestInit = {}) => {
    const signal = init.signal!, abort = (fail: (e: unknown) => void) => signal.addEventListener('abort', () => fail(signal.reason), { once: true });
    if (!o.body) return new Promise<Response>((_, rej) => abort(rej));
    return new Response(new ReadableStream({ start: c => abort(e => c.error(e)) }), { status: url.endsWith('/v1/projects') ? 201 : 200 });
  }) as typeof fetch;
  const elapsed = async (p: Promise<unknown>) => { const t = Date.now(), err = await p.then(() => new Error('resolved'), (e: Error) => e); return { err, ms: Date.now() - t }; };

  it('a poll whose response never comes still fails at the deadline, with the ref and "left in place"', async () => {
    const { f } = fake(happy());
    const fetch = (async (url: string, init?: RequestInit) => url.endsWith('/v1/projects') ? f(url, init) : stalled()(url, init)) as typeof globalThis.fetch;
    const { err, ms } = await elapsed(run({}, { fetch, now: Date.now, sleep: undefined, timeoutMs: 50, intervalMs: 10 }).p);
    expect(err.message).toMatch(new RegExp(`${REF}.*GET /v1/projects/${REF}: no response within 0.05s.*left in place`));
    expect(ms).toBeLessThan(1000);
  });

  it('a body that never finishes is cut too; on create it warns that a project may exist', async () => {
    const { err, ms } = await elapsed(run({}, { fetch: stalled({ body: true }), now: Date.now, sleep: undefined, timeoutMs: 50, intervalMs: 10 }).p);
    expect(err.message).toMatch(/POST \/v1\/projects: no response within 0.05s; a project may have been created/);
    expect(ms).toBeLessThan(1000);
  });

  it('INIT_FAILED stops polling at once', async () => {
    const r = run(happy({ [`GET /v1/projects/${REF}`]: [ok({ ref: REF, status: 'INIT_FAILED' })] }));
    await expect(r.p).rejects.toThrow(new RegExp(`${REF}.*INIT_FAILED.*left in place`));
    expect(r.calls).toHaveLength(2);
  });

  it('a 4xx on create fails with a truncated body, never the token', async () => {
    const r = run({ 'POST /v1/projects': [{ status: 400, body: { message: `bad org ${'x'.repeat(500)} ${TOKEN}` } }] });
    const err = await r.p.then(() => new Error('resolved'), (e: Error) => e);
    expect(err.message).toMatch(/POST \/v1\/projects: HTTP 400 \{"message":"bad org x+/);
    expect(err.message.length).toBeLessThan(400);
    expect(err.message).not.toContain(TOKEN);
    expect(r.calls).toHaveLength(1);
  });

  it('honors 429 Retry-After on create and while polling; retries a pooler that is not ready yet', async () => {
    const r = run(happy({
      'POST /v1/projects': [{ status: 429, headers: { 'retry-after': '30' } }, { status: 201, body: { ref: REF, status: 'COMING_UP' } }],
      [`GET /v1/projects/${REF}`]: [{ status: 429, headers: { 'retry-after': '45' } }, ok({ ref: REF, status: 'ACTIVE_HEALTHY' })],
      [`GET /v1/projects/${REF}/config/database/pooler`]: [{ status: 500, body: { message: 'not ready' } }, ok([]), ok(POOLER)],
    }));
    expect((await r.p).SUPABASE_DB_URL).toMatch(/@aws-1-ap-northeast-2\.pooler\.supabase\.com:5432\/postgres\?sslmode=require$/);
    expect(r.slept).toEqual([30_000, 45_000, 10_000, 10_000]);
  });

  it('a sustained 429 on create gives up at the timeout: nothing was created, so no ref and no "left in place"', async () => {
    const r = run({ 'POST /v1/projects': [{ status: 429, headers: { 'retry-after': '30' } }] }, { timeoutMs: 60_000 });
    const err = await r.p.then(() => new Error('resolved'), (e: Error) => e);
    expect(err.message).toMatch(/POST \/v1\/projects: HTTP 429 .*within 60s; no project was created/);
    expect(err.message).not.toMatch(/left in place/);
    expect(r.calls.map(c => c.method)).toEqual(['POST', 'POST', 'POST']);   // t = 0, 30, 60s
    expect(r.slept).toEqual([30_000, 30_000]);
  });

  it('a 401 while polling fails at once with the ref', async () => {
    const r = run(happy({ [`GET /v1/projects/${REF}`]: [{ status: 401, body: { message: 'Unauthorized' } }] }));
    await expect(r.p).rejects.toThrow(new RegExp(`${REF}.*HTTP 401.*left in place`));
    expect(r.calls).toHaveLength(2);
  });

  it('missing legacy JWT keys fail with the ref (the server needs anon and service_role)', async () => {
    const r = run(happy({ [`GET /v1/projects/${REF}/api-keys`]: [ok(KEYS.slice(2))] }));
    await expect(r.p).rejects.toThrow(new RegExp(`${REF}.*legacy anon/service_role keys.*left in place`));
  });

  it('fault anon_as_service writes the service key as SUPABASE_ANON_KEY with a loud warning (G3 8)', async () => {
    const r = run(happy(), { fault: 'anon_as_service' });
    expect((await r.p).SUPABASE_ANON_KEY).toBe(SERVICE);
    expect(r.log.join('\n')).toMatch(/WARNING.*DEPLOY_NEW_FAULT=anon_as_service/);
  });
});

describe('writeNewEnv', () => {
  it('writes exactly the four SUPABASE_* lines with mode 600, over the empty mktemp file', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'new-project-')), 'env');
    writeFileSync(f, '', { mode: 0o644 });
    const v = await run(happy()).p;
    writeNewEnv(f, v);
    expect(readFileSync(f, 'utf8')).toBe(`SUPABASE_URL=${v.SUPABASE_URL}\nSUPABASE_SERVICE_KEY=${SERVICE}\nSUPABASE_DB_URL=${v.SUPABASE_DB_URL}\nSUPABASE_ANON_KEY=${ANON}\n`);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readFileSync(f, 'utf8')).not.toContain(TOKEN);
  });
});
