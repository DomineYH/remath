import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import type { Db } from './db.ts';

const config = loadConfig({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'k', MOCK_LLM: '1' },
  p => readFileSync(new URL(p, new URL('../../', import.meta.url)), 'utf8'));
// 여기 경로들은 DB에 닿기 전에 끝난다. 닿으면 테스트가 터진다.
const db = new Proxy({}, { get: () => { throw new Error('db must not be used'); } }) as Db;

describe('app wiring (A-2, M-2, O-8)', () => {
  it('GET /healthz is 200 outside the route table', async () => {
    const app = await buildApp({ db, config });
    const r = await app.inject('/healthz');
    expect(r.statusCode).toBe(200);
  });
  it('table routes without a handler stay unregistered (Fastify 404)', async () => {
    const app = await buildApp({ db, config });
    expect((await app.inject('/api/admin/ai/providers')).statusCode).toBe(404);
  });
  it('a zod failure is 400 validation_failed in the {error:{code,message,details}} shape', async () => {
    const app = await buildApp({ db, config });
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { nickname: 'a@b', password: 'short' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({ code: 'validation_failed', message: expect.any(String), details: expect.any(Array) });
  });
  it('no cookie on a realm route is 401 unauthorized, checked before the body', async () => {
    const app = await buildApp({ db, config });
    const r = await app.inject({ method: 'PUT', url: '/api/admin/auth/password', payload: {} });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('unauthorized');
  });
  it("'any' session routes resolve the realm before the DB: no cookie 401, both cookies without X-Remath-Realm 400 (C-9)", async () => {
    const app = await buildApp({ db, config });
    expect((await app.inject({ method: 'POST', url: '/api/sessions/x/turns', payload: { text: 'hi' } })).statusCode).toBe(401);
    const both = await app.inject({ url: '/api/sessions/current', cookies: { remath_teacher: 't', remath_admin: 'a' } });
    expect(both.statusCode).toBe(400);
    expect(both.json().error.code).toBe('validation_failed');
  });
  it('request logs carry neither the body nor cookie values', async () => {
    let logs = '';
    const stream = new Writable({ write(chunk, _enc, cb) { logs += chunk; cb(); } });
    const app = await buildApp({ db, config }, { logger: { stream } });
    await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { nickname: 'x', password: 'Secret-pw-123' },
      headers: { cookie: 'remath_teacher=cookie-token-abc' } });
    expect(logs).toContain('/api/auth/signup');
    expect(logs).not.toContain('Secret-pw-123');
    expect(logs).not.toContain('cookie-token-abc');
  });
});
