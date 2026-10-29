import { describe, expect, it } from 'vitest';
import { jarFetch } from './jar.ts';

/** A fake server: answers each call with the next set-cookie lines and records the cookie header it got. */
function server(...replies: string[][]) {
  const got: (string | null)[] = [];
  const f = (async (_url: URL, init: RequestInit) => {
    got.push(new Headers(init.headers).get('cookie'));
    const h = new Headers();
    for (const c of replies.shift() ?? []) h.append('set-cookie', c);
    return new Response(null, { headers: h });
  }) as unknown as typeof fetch;
  return { f, got };
}

describe('jarFetch', () => {
  it('stores set-cookie and sends it back; another jar is another browser', async () => {
    const s = server(['a=1; Path=/; HttpOnly; SameSite=Lax', 'b=2; Path=/']);
    const one = jarFetch(s.f), two = jarFetch(s.f);
    await one('http://h/api/x');
    await one('http://h/api/y');
    await two('http://h/api/y');
    expect(s.got).toEqual([null, 'a=1; b=2', null]);
  });
  it('Path: sent only under its path; default path is the request directory; longer paths first', async () => {
    const s = server(['p=1; Path=/api/admin', 'd=2', 'r=3; Path=/']);
    const f = jarFetch(s.f);
    await f('http://h/api/auth/login');
    for (const u of ['http://h/api/admin/x', 'http://h/api/adminx', 'http://h/api/auth/me', 'http://h/']) await f(u);
    expect(s.got.slice(1)).toEqual(['p=1; r=3', 'r=3', 'd=2; r=3', 'r=3']);
  });
  it('expiry: Max-Age=0 or a past Expires removes the cookie (logout empties the jar); Max-Age wins over Expires', async () => {
    const s = server(['a=1; Path=/', 'b=2; Path=/; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT'],
      ['a=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'], ['b=; Path=/; Max-Age=0']);
    const f = jarFetch(s.f);
    for (let i = 0; i < 4; i++) await f('http://h/api/x');
    expect(s.got).toEqual([null, 'a=1; b=2', 'b=2', null]);
    expect(f.jar.size).toBe(0);
  });
});
