import { describe, expect, it } from 'vitest';
import { createLimiter, resolveRealm } from './auth.ts';

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

describe('login failure counter (C-8, O-12)', () => {
  const failN = (l: ReturnType<typeof createLimiter>, n: number, nick = 'Kim', at = 0, realm: 'teacher' | 'admin' = 'teacher') => { for (let i = 0; i < n; i++) l.fail(realm, nick, at); };
  it('the 5th failure locks the (realm, nickname) for 60 s with retry_after in seconds', () => {
    const l = createLimiter();
    failN(l, 4);
    expect(l.check('teacher', 'Kim', 0)).toBeNull();
    l.fail('teacher', 'Kim', 1000);
    expect(l.check('teacher', 'Kim', 1000)).toBe(60);
    expect(l.check('teacher', 'Kim', 60_500)).toBe(1);
    expect(l.check('teacher', 'Kim', 61_000)).toBeNull();
    l.fail('teacher', 'Kim', 61_000);   // after the lock the count starts again
    expect(l.check('teacher', 'Kim', 61_000)).toBeNull();
  });
  it('nickname is case-insensitive', () => {
    const l = createLimiter();
    failN(l, 3, 'Kim'); failN(l, 2, 'KIM');
    expect(l.check('teacher', 'kim', 0)).toBe(60);
  });
  it('realms are counted separately', () => {
    const l = createLimiter();
    failN(l, 5, 'admin', 0, 'teacher');
    expect(l.check('admin', 'admin', 0)).toBeNull();
    expect(l.check('teacher', 'admin', 0)).toBe(60);
  });
  it('success resets the count', () => {
    const l = createLimiter();
    failN(l, 4); l.reset('teacher', 'kim'); failN(l, 1);
    expect(l.check('teacher', 'Kim', 0)).toBeNull();
  });
  it('failures more than 60 s apart do not add up', () => {
    const l = createLimiter();
    failN(l, 4, 'Kim', 0); l.fail('teacher', 'Kim', 60_001);
    expect(l.check('teacher', 'Kim', 60_001)).toBeNull();
  });
});
