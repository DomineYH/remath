// The seam A target itself: an injected (non-default) target drives target(), and browser() is another browser on the same server.
import { describe, expect, it } from 'vitest';
import { mockTarget, target, useTarget, type Factory } from './seam.ts';

const creds = { nickname: 'Haneul', password: 'abcd1234' };

describe('seam A target', () => {
  it('an injected target replaces the mock default; browser() keeps its own logins but shares the data', async () => {
    const base = mockTarget(), seen: string[] = [];
    const wrap = (f: Factory, tag: string): Factory => realm => (seen.push(`${tag}:${realm}`), f(realm));
    useTarget(() => ({ api: wrap(base.api, 'api'), browser: () => wrap(base.browser(), 'browser') }));
    try {
      const t = target({ turnLimit: 1 });   // mock options are ignored once a target is injected
      const me = await t.api('teacher').signup(creds);
      const other = t.browser()('teacher');
      await expect(other.me()).rejects.toMatchObject({ status: 401 });
      expect((await other.login(creds)).id).toBe(me.id);
      expect(seen).toEqual(['api:teacher', 'browser:teacher']);
      expect(base.store.db.users.map(u => u.nickname)).toContain('Haneul');
    } finally { useTarget(undefined); }
    await expect(target().api('teacher').me()).rejects.toMatchObject({ status: 401 });   // back to a fresh mock server
  });
});
