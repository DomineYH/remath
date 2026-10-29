// A-9 (initial state · env admin password · persist/restore · one key) and the A-5 auth rules.
// HTTP groups (A-5, C-10) run on any target (seam.ts); A-9 and the audit helper (A-8) are [mock] groups.
import * as S from '@remath/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../types.ts';
import { ADMIN_PW, describeMock, mockTarget, T0, target, type Target } from '../seam.ts';
import { createMockApi } from './index.ts';
import { memoryStorage, seedDb, Store, STORAGE_KEY, type Storage } from './store.ts';

const creds = { nickname: 'Haneul', password: 'abcd1234' };

function setup(t: Target = target()) {
  return { t, teacher: t.api('teacher'), admin: t.api('admin') };
}
const stored = (storage: Storage) => mockTarget({ store: new Store(storage, () => seedDb(T0)) });

async function rejects(p: Promise<unknown>, status: number, code: string): Promise<ApiError> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect([(e as ApiError).status, (e as ApiError).code]).toEqual([status, code]);
    return e as ApiError;
  }
  throw new Error(`expected ${status} ${code}`);
}

const recording = () => {
  const inner = memoryStorage(), keys: string[] = [];
  return { keys, storage: { ...inner, setItem: (k: string, v: string) => { keys.push(k); inner.setItem(k, v); } } };
};

describeMock('A-9 initial state (G-33)', () => {
  it('no teachers, groups or sessions; one admin; the five published samples', async () => {
    const t = mockTarget(), { store } = t, { teacher, admin } = setup(t);
    expect(store.db.users.map(u => [u.nickname, u.role])).toEqual([['admin', 'admin']]);
    await admin.adminLogin({ nickname: 'admin', password: ADMIN_PW });
    expect(await admin.listUsers()).toEqual([]);
    expect(await admin.listGroups()).toEqual([]);
    expect(await admin.listAdminSessions({})).toEqual([]);
    expect((await admin.listScenarios()).map(s => [s.slug, s.status])).toEqual(['gabriel', 'noah', 'jiwoo', 'hajun', 'seoyeon'].map(x => [x, 'published']));
    await teacher.signup(creds);
    expect(await teacher.getPractice()).toEqual({ groups: [], scenarios: [] });
    expect(await teacher.listSessions()).toEqual([]);
    expect(store.db.audit_log).toEqual([]);
  });
});

describeMock('A-9 admin password from env (G-33)', () => {
  for (const adminPassword of [undefined, '']) {
    it(`unset (${JSON.stringify(adminPassword)}) → every admin login is 401`, async () => {
      const { admin } = setup(mockTarget({ adminPassword }));
      await rejects(admin.adminLogin({ nickname: 'admin', password: ADMIN_PW }), 401, 'invalid_credentials');
    });
  }
  it('set → admin logs in; realms do not cross', async () => {
    const { teacher, admin } = setup(mockTarget());
    expect((await admin.adminLogin({ nickname: 'admin', password: ADMIN_PW })).role).toBe('admin');
    await rejects(teacher.login({ nickname: 'admin', password: ADMIN_PW }), 401, 'invalid_credentials');
    await teacher.signup(creds);
    await rejects(admin.adminLogin(creds), 401, 'invalid_credentials');
  });
});

describeMock('A-9 storage (G-32)', () => {
  it('persists and restores without reseeding', async () => {
    const storage = memoryStorage(), { teacher } = setup(stored(storage));
    await teacher.signup(creds);
    const store2 = new Store(storage, () => { throw new Error('reseeded'); });
    const again = createMockApi({ realm: 'teacher', store: store2, now: () => T0, adminPassword: ADMIN_PW });
    expect((await again.me()).nickname).toBe('Haneul');
  });
  it('writes only the remath.mock.v1 key', async () => {
    const { keys, storage } = recording();
    const { teacher } = setup(stored(storage));
    await teacher.signup(creds);
    await teacher.logout();
    await teacher.login(creds);
    await teacher.changePassword({ current: creds.password, next: 'efgh5678' });
    await rejects(teacher.login({ ...creds, password: 'wrong999' }), 401, 'invalid_credentials');
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(new Set([STORAGE_KEY]));
    expect(STORAGE_KEY).toBe('remath.mock.v1');
  });
  it('stores hashes, never plaintext', async () => {
    const storage = memoryStorage(), { teacher, admin } = setup(stored(storage));
    await teacher.signup(creds);
    await admin.adminLogin({ nickname: 'admin', password: ADMIN_PW });
    await admin.adminChangePassword({ current: ADMIN_PW, next: 'NewAdmin99' });
    const raw = storage.getItem(STORAGE_KEY)!;
    for (const pw of [creds.password, ADMIN_PW, 'NewAdmin99']) expect(raw).not.toContain(pw);
    const db = JSON.parse(raw);
    for (const u of db.users) expect(u.password_hash).toMatch(/^sha256\$/);
    expect(db).not.toHaveProperty('users.0.summary');
  });
});

describe('A-5 signup and validation', () => {
  it('signup logs in', async () => {
    const { teacher } = setup();
    const me = await teacher.signup(creds);
    expect(me).toMatchObject({ nickname: 'Haneul', role: 'teacher' });
    expect(await teacher.me()).toEqual(me);
  });
  for (const nickname of ['a', 'a@b', 'a@b.c', '12345678', 'x'.repeat(17), 'has space']) {
    it(`nickname ${JSON.stringify(nickname)} → 400`, async () => {
      await rejects(setup().teacher.signup({ nickname, password: 'abcd1234' }), 400, 'validation_failed');
    });
  }
  for (const password of ['abcdefgh', '12345678', 'abc 1234', 'ab12']) {
    it(`password ${JSON.stringify(password)} → 400`, async () => {
      await rejects(setup().teacher.signup({ nickname: 'tester1', password }), 400, 'validation_failed');
    });
  }
  it('duplicate nickname (case-insensitive, any role) → 409', async () => {
    const { teacher, t } = setup();
    await teacher.signup(creds);
    const other = t.browser()('teacher');
    await rejects(other.signup({ ...creds, nickname: 'Haneul' }), 409, 'nickname_taken');
    await rejects(other.signup({ ...creds, nickname: 'haneul' }), 409, 'nickname_taken');
    await rejects(other.signup({ ...creds, nickname: 'admin' }), 409, 'nickname_taken');
  });
  it('401 does not tell unknown nickname from wrong password', async () => {
    const { teacher } = setup();
    await teacher.signup(creds);
    await teacher.logout();
    const a = await rejects(teacher.login({ nickname: 'nobody', password: 'abcd1234' }), 401, 'invalid_credentials');
    const b = await rejects(teacher.login({ nickname: 'Haneul', password: 'wrong999' }), 401, 'invalid_credentials');
    expect(a.body).toEqual(b.body);
  });
});

describe('A-5 password change ends other logins', () => {
  it('teacher', async () => {
    const { teacher: a, t } = setup();
    await a.signup(creds);
    const b = t.browser()('teacher');
    await b.login(creds);
    await rejects(a.changePassword({ current: 'wrong999', next: 'efgh5678' }), 401, 'invalid_credentials');
    expect((await b.me()).nickname).toBe('Haneul');
    await a.changePassword({ current: creds.password, next: 'efgh5678' });
    await rejects(b.me(), 401, 'unauthorized');
    expect((await a.me()).nickname).toBe('Haneul');
    await rejects(b.login(creds), 401, 'invalid_credentials');
    await b.login({ ...creds, password: 'efgh5678' });
  });
  it('admin', async () => {
    const { admin: a, t } = setup();
    const b = t.browser()('admin');
    await a.adminLogin({ nickname: 'admin', password: ADMIN_PW });
    await b.adminLogin({ nickname: 'admin', password: ADMIN_PW });
    await a.adminChangePassword({ current: ADMIN_PW, next: 'NewAdmin99' });
    await rejects(b.adminMe(), 401, 'unauthorized');
    expect((await a.adminMe()).role).toBe('admin');
    await rejects(b.adminLogin({ nickname: 'admin', password: ADMIN_PW }), 401, 'invalid_credentials');
    await b.adminLogin({ nickname: 'admin', password: 'NewAdmin99' });
  });
});

describe('A-5 logout and realm separation (C-10)', () => {
  it('logout ends the login', async () => {
    const { teacher } = setup();
    await teacher.signup(creds);
    await teacher.logout();
    await rejects(teacher.me(), 401, 'unauthorized');
    await rejects(teacher.logout(), 401, 'unauthorized');
  });
  it('teacher login does not open admin routes and vice versa', async () => {
    const { teacher, admin } = setup();
    await teacher.signup(creds);
    await rejects(admin.listUsers(), 401, 'unauthorized');
    await rejects(admin.adminMe(), 401, 'unauthorized');
    await teacher.logout();
    await admin.adminLogin({ nickname: 'admin', password: ADMIN_PW });
    await rejects(teacher.getPractice(), 401, 'unauthorized');
    await rejects(teacher.me(), 401, 'unauthorized');
  });
  it('auth (401) comes before body validation (400), as the server middleware orders them', async () => {
    const { teacher, admin } = setup();
    await rejects(admin.createUser({ nickname: '', password: '' }), 401, 'unauthorized');
    await rejects(teacher.changePassword({ current: '', next: '' }), 401, 'unauthorized');
    await rejects(teacher.sendTurn('x', { text: '' })[Symbol.asyncIterator]().next() as Promise<unknown>, 401, 'unauthorized');
  });
});

describeMock('A-8 audit helper (D-21)', () => {
  it('failed login → one auth.login_failed; password change → one auth.password_change', async () => {
    const t = mockTarget(), { store } = t, { teacher, admin } = setup(t);
    await rejects(admin.adminLogin({ nickname: 'admin', password: 'wrong999' }), 401, 'invalid_credentials');
    expect(store.db.audit_log).toHaveLength(1);
    const failed = S.AuditEntry.parse(store.db.audit_log[0]);
    expect(failed).toMatchObject({ action: 'auth.login_failed', actor_id: null, target: 'admin', meta: { realm: 'admin', reason: 'invalid_credentials' } });

    const me = await teacher.signup(creds);
    await rejects(teacher.changePassword({ current: 'wrong999', next: 'efgh5678' }), 401, 'invalid_credentials');
    expect(store.db.audit_log).toHaveLength(1);
    await teacher.changePassword({ current: creds.password, next: 'efgh5678' });
    expect(store.db.audit_log).toHaveLength(2);
    expect(S.AuditEntry.parse(store.db.audit_log[1])).toMatchObject({ action: 'auth.password_change', actor_id: me.id, target: me.id, meta: { realm: 'teacher' } });

    const json = JSON.stringify(store.db.audit_log);
    for (const s of ['wrong999', creds.password, 'efgh5678', 'updated_at', 'sha256$']) expect(json).not.toContain(s);
  });
});
