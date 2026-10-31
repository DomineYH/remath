import { describe, expect, it } from 'vitest';
import { createLimiter, resolveRealm } from './auth.ts';
import type { Db } from './db.ts';

describe('resolveRealm (C-9)', () => {
  const both = { teacher: 't-tok', admin: 'a-tok' };
  it('teacher/admin routes read only their own cookie', () => {
    expect(resolveRealm('teacher', undefined, both)).toEqual({ realm: 'teacher', token: 't-tok' });
    expect(resolveRealm('admin', 'teacher', both)).toEqual({ realm: 'admin', token: 'a-tok' });
    expect(resolveRealm('admin', undefined, { teacher: 't-tok' })).toEqual({ error: 'unauthorized' });
  });
  it('any + header: only that realm cookie counts', () => {
    expect(resolveRealm('any', 'admin', both)).toEqual({ realm: 'admin', token: 'a-tok' });
    expect(resolveRealm('any', 'teacher', { admin: 'a-tok' })).toEqual({ error: 'unauthorized' });
    expect(resolveRealm('any', 'root', both)).toEqual({ error: 'validation_failed' });
  });
  it('any without header: the single cookie is used', () => {
    expect(resolveRealm('any', undefined, { admin: 'a-tok' })).toEqual({ realm: 'admin', token: 'a-tok' });
    expect(resolveRealm('any', undefined, { teacher: 't-tok' })).toEqual({ realm: 'teacher', token: 't-tok' });
  });
  it('any without header: two cookies = 400, none = 401', () => {
    expect(resolveRealm('any', undefined, both)).toEqual({ error: 'validation_failed' });
    expect(resolveRealm('any', undefined, {})).toEqual({ error: 'unauthorized' });
  });
});

describe('login failure counter over rpc (C-8, O-12, V12)', () => {
  // The rule itself (5 fails → 60 s lock, window, reset, case, realms, concurrency) is 0006_login_limits.sql, tested on PGlite.
  // Here: each operation is exactly one rpc with the right arguments, its answer is passed through, and a DB error is thrown.
  const fakeDb = (answers: Record<string, unknown> = {}, error: unknown = null) => {
    const calls: [string, unknown][] = [];
    const db = { rpc: async (name: string, args: unknown) => { calls.push([name, args]); return error ? { data: null, error } : { data: answers[name] ?? null, error: null }; } } as unknown as Db;
    return { db, calls };
  };
  it('check → login_check(realm, nickname as typed); null or retry_after seconds', async () => {
    const f = fakeDb({ login_check: 42 });
    expect(await createLimiter(f.db).check('admin', 'Kim')).toBe(42);
    expect(await createLimiter(fakeDb().db).check('teacher', 'Kim')).toBeNull();
    expect(f.calls).toEqual([['login_check', { p_realm: 'admin', p_nick: 'Kim' }]]);
  });
  it('fail → one login_fail, which answers whether this failure locked it', async () => {
    const f = fakeDb({ login_fail: 60 });
    expect(await createLimiter(f.db).fail('teacher', 'Kim')).toBe(60);
    expect(await createLimiter(fakeDb().db).fail('teacher', 'Kim')).toBeNull();
    expect(f.calls).toEqual([['login_fail', { p_realm: 'teacher', p_nick: 'Kim' }]]);
  });
  it('reset → login_reset', async () => {
    const f = fakeDb();
    await createLimiter(f.db).reset('teacher', 'Kim');
    expect(f.calls).toEqual([['login_reset', { p_realm: 'teacher', p_nick: 'Kim' }]]);
  });
  it('a DB error is thrown, never read as "not locked"', async () => {
    const l = createLimiter(fakeDb({}, { code: 'XX000', message: 'down' }).db);
    await expect(l.check('teacher', 'Kim')).rejects.toMatchObject({ code: 'XX000' });
    await expect(l.fail('teacher', 'Kim')).rejects.toMatchObject({ code: 'XX000' });
    await expect(l.reset('teacher', 'Kim')).rejects.toMatchObject({ code: 'XX000' });
  });
});
