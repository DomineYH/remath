// A-5 (admin users·groups, getPractice's two empty cases) and the user.*·group.* rows of A-8, against the mock API only.
import * as S from '@remath/shared';
import { describe, expect, it } from 'vitest';
import { ApiError, type Api } from '../types.ts';
import { createMockApi, type MockOptions } from './index.ts';
import { memoryStorage, seedDb, Store } from './store.ts';

const T0 = '2026-10-28T00:00:00.000Z';
const ADMIN_PW = 'Admin1234';
const PW = 'abcd1234';

async function setup() {
  const store = new Store(memoryStorage(), () => seedDb(T0));
  const mk = (realm: 'teacher' | 'admin', more: Partial<MockOptions> = {}) => createMockApi({ realm, store, now: () => T0, adminPassword: ADMIN_PW, ...more });
  /** Another browser: its own cookie jar on the same server. */
  const browser = () => mk('teacher', { cookies: { teacher: null, admin: null } });
  const admin = mk('admin');
  await admin.adminLogin({ nickname: 'admin', password: ADMIN_PW });
  const ids = Object.fromEntries((await admin.listScenarios()).map(s => [s.slug, s.id]));
  const adminId = (await admin.adminMe()).id;
  return { store, admin, browser, ids, adminId };
}

async function rejects(p: Promise<unknown>, status: number, code: string): Promise<ApiError> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect([(e as ApiError).status, (e as ApiError).code]).toEqual([status, code]);
    return e as ApiError;
  }
  throw new Error(`expected ${status} ${code}`);
}
const drain = async <E>(it: AsyncIterable<E>) => { const out: E[] = []; for await (const e of it) out.push(e); return out; };
const loginAs = async (t: Api, nickname: string, password = PW) => t.login({ nickname, password });

describe('A-5 users', () => {
  it('createUser returns a UserRow with no groups; the user can log in; listUsers shows teachers only', async () => {
    const { admin, browser } = await setup();
    const u = await admin.createUser({ nickname: 'Haneul', password: PW });
    expect(S.UserRow.strict().parse(u)).toMatchObject({ nickname: 'Haneul', groups: [], scenario_count: 0, session_count: 0, created_at: T0, pw_updated_at: T0 });
    expect(await admin.listUsers()).toEqual([u]);
    expect((await loginAs(browser(), 'Haneul')).id).toBe(u.id);
  });
  it('duplicate nickname (case-insensitive, admin included) → 409; nickname and password rules → 400', async () => {
    const { admin } = await setup();
    await admin.createUser({ nickname: 'Haneul', password: PW });
    for (const nickname of ['haneul', 'HANEUL', 'Admin']) await rejects(admin.createUser({ nickname, password: PW }), 409, 'nickname_taken');
    for (const nickname of ['a@b', '01012345678', 'x']) await rejects(admin.createUser({ nickname, password: PW }), 400, 'validation_failed');
    for (const password of ['abcdefgh', 'ab12', 'abc 1234']) await rejects(admin.createUser({ nickname: 'Other1', password }), 400, 'validation_failed');
    expect(await admin.listUsers()).toHaveLength(1);
  });
  it('resetUserPassword ends every login of that user; the new password works', async () => {
    const { admin, browser } = await setup();
    const u = await admin.createUser({ nickname: 'Haneul', password: PW });
    const a = browser(), b = browser();
    await loginAs(a, 'Haneul'); await loginAs(b, 'Haneul');
    await admin.resetUserPassword(u.id, { password: 'efgh5678' });
    await rejects(a.me(), 401, 'unauthorized');
    await rejects(b.me(), 401, 'unauthorized');
    await rejects(loginAs(a, 'Haneul'), 401, 'invalid_credentials');
    await loginAs(a, 'Haneul', 'efgh5678');
    await rejects(admin.resetUserPassword(u.id, { password: 'short' }), 400, 'validation_failed');
    await rejects(admin.resetUserPassword(crypto.randomUUID(), { password: 'efgh5678' }), 404, 'not_found');
  });
  it('deleteUser cascades sessions·turns·memberships and ends their logins; unknown id → 404; admin cannot be deleted', async () => {
    const { admin, browser, ids, adminId } = await setup();
    const u = await admin.createUser({ nickname: 'Haneul', password: PW });
    const g = await admin.createGroup({ name: 'A반', member_ids: [u.id], scenario_ids: [ids.gabriel] });
    const t = browser();
    await loginAs(t, 'Haneul');
    const d = await t.startSession({ scenario_id: ids.gabriel });
    await drain(t.sendTurn(d.session.id, { text: '어떻게 풀었는지 말해 줄래?' }));
    expect((await admin.listUsers())[0].session_count).toBe(1);
    await admin.deleteUser(u.id);
    expect(await admin.listUsers()).toEqual([]);
    expect(await admin.listAdminSessions({})).toEqual([]);
    await rejects(admin.getAdminSession(d.session.id), 404, 'not_found');
    expect((await admin.listGroups()).find(x => x.id === g.id)!.members).toEqual([]);
    expect((await admin.listScenarios()).find(s => s.id === ids.gabriel)!.session_count).toBe(0);
    await rejects(t.me(), 401, 'unauthorized');
    await rejects(admin.deleteUser(u.id), 404, 'not_found');
    await rejects(admin.deleteUser(adminId), 404, 'not_found');
  });
  it('UserRow.scenario_count counts distinct scenarios across groups; session_count counts sessions', async () => {
    const { admin, browser, ids } = await setup();
    const u = await admin.createUser({ nickname: 'Haneul', password: PW });
    await admin.createGroup({ name: 'A', member_ids: [u.id], scenario_ids: [ids.gabriel, ids.noah] });
    await admin.createGroup({ name: 'B', member_ids: [u.id], scenario_ids: [ids.noah, ids.jiwoo] });
    const t = browser();
    await loginAs(t, 'Haneul');
    await t.endSession((await t.startSession({ scenario_id: ids.noah })).session.id);
    await t.startSession({ scenario_id: ids.jiwoo });
    expect((await admin.listUsers())[0]).toMatchObject({ scenario_count: 3, session_count: 2, groups: [{ name: 'A' }, { name: 'B' }] });
  });
});

describe('A-5 groups', () => {
  it('createGroup → Group with members and scenarios; updateGroup replaces everything; deleteGroup removes it', async () => {
    const { admin, ids } = await setup();
    const a = await admin.createUser({ nickname: 'Haneul', password: PW }), b = await admin.createUser({ nickname: 'Bora', password: PW });
    const g = await admin.createGroup({ name: '  A반  ', member_ids: [a.id], scenario_ids: [ids.gabriel] });
    expect(S.Group.strict().parse(g)).toMatchObject({ name: 'A반', members: [{ id: a.id, nickname: 'Haneul' }], scenarios: [{ id: ids.gabriel, name: '가브리엘', lang: 'ko', status: 'published' }] });
    const g2 = await admin.updateGroup(g.id, { name: 'B반', member_ids: [b.id], scenario_ids: [ids.noah] });
    expect(g2).toMatchObject({ id: g.id, name: 'B반', members: [{ id: b.id }], scenarios: [{ id: ids.noah }] });
    expect(await admin.listGroups()).toEqual([g2]);
    expect((await admin.updateGroup(g.id, { name: 'B반', member_ids: [], scenario_ids: [] }))).toMatchObject({ members: [], scenarios: [] });
    await admin.deleteGroup(g.id);
    expect(await admin.listGroups()).toEqual([]);
    expect((await admin.listUsers()).map(u => u.nickname)).toEqual(['Haneul', 'Bora']);   // users stay
    await rejects(admin.deleteGroup(g.id), 404, 'not_found');
    await rejects(admin.updateGroup(g.id, { name: 'x', member_ids: [], scenario_ids: [] }), 404, 'not_found');
  });
  it('validation: empty name, unknown member or scenario id, an admin as member → 400', async () => {
    const { admin, ids, adminId } = await setup();
    const u = await admin.createUser({ nickname: 'Haneul', password: PW });
    await rejects(admin.createGroup({ name: '  ', member_ids: [], scenario_ids: [] }), 400, 'validation_failed');
    await rejects(admin.createGroup({ name: 'A', member_ids: [crypto.randomUUID()], scenario_ids: [] }), 400, 'validation_failed');
    await rejects(admin.createGroup({ name: 'A', member_ids: [adminId], scenario_ids: [] }), 400, 'validation_failed');
    await rejects(admin.createGroup({ name: 'A', member_ids: [u.id], scenario_ids: [crypto.randomUUID()] }), 400, 'validation_failed');
    const g = await admin.createGroup({ name: 'A', member_ids: [u.id, u.id], scenario_ids: [ids.gabriel, ids.gabriel] });
    expect([g.members.length, g.scenarios.length]).toEqual([1, 1]);
    expect(await admin.listGroups()).toHaveLength(1);
  });
  it('the scenario card and getScenario list the groups that use a scenario', async () => {
    const { admin, ids } = await setup();
    const g = await admin.createGroup({ name: 'A반', member_ids: [], scenario_ids: [ids.gabriel] });
    expect((await admin.listScenarios()).find(s => s.id === ids.gabriel)!.groups).toEqual([{ id: g.id, name: 'A반' }]);
    expect((await admin.getScenario(ids.gabriel)).groups).toEqual([{ id: g.id, name: 'A반' }]);
  });
});

describe('A-5 getPractice: no group → no scenario → visible (teacher_scenarios = published ∧ in my group)', () => {
  it('walks the three states and keeps drafts and other groups out', async () => {
    const { admin, browser, ids, store } = await setup();
    const u = await admin.createUser({ nickname: 'Haneul', password: PW }), other = await admin.createUser({ nickname: 'Bora', password: PW });
    const t = browser();
    await loginAs(t, 'Haneul');
    expect(await t.getPractice()).toEqual({ groups: [], scenarios: [] });
    const g = await admin.createGroup({ name: 'A반', member_ids: [u.id], scenario_ids: [] });
    expect(await t.getPractice()).toEqual({ groups: [{ id: g.id, name: 'A반' }], scenarios: [] });
    await admin.createGroup({ name: 'B반', member_ids: [other.id], scenario_ids: [ids.noah] });
    await admin.updateGroup(g.id, { name: 'A반', member_ids: [u.id], scenario_ids: [ids.seoyeon, ids.jiwoo] });
    const g2 = await admin.createGroup({ name: 'C반', member_ids: [u.id], scenario_ids: [ids.seoyeon] });
    store.db.scenarios.find(s => s.id === ids.jiwoo)!.status = 'draft';   // drafts never reach teachers (the wizard is #26)
    const home = await t.getPractice();
    expect(home.groups.map(x => x.name)).toEqual(['A반', 'C반']);
    expect(home.scenarios.map(s => [s.slug, s.group_ids])).toEqual([['seoyeon', [g.id, g2.id]]]);
  });
});

describe('A-8 audit rows for user.* and group.*', () => {
  it('one row after each successful write, with the ticket-20 meta; failed writes leave none', async () => {
    const { admin, store, ids, adminId, browser } = await setup();
    const rows = () => store.db.audit_log.filter(r => r.action.startsWith('user.') || r.action.startsWith('group.'));
    const u = await admin.createUser({ nickname: 'Haneul', password: PW });
    await rejects(admin.createUser({ nickname: 'haneul', password: PW }), 409, 'nickname_taken');
    await admin.resetUserPassword(u.id, { password: 'efgh5678' });
    await rejects(admin.resetUserPassword(crypto.randomUUID(), { password: 'efgh5678' }), 404, 'not_found');
    const g = await admin.createGroup({ name: 'A반', member_ids: [u.id], scenario_ids: [ids.gabriel] });
    await rejects(admin.createGroup({ name: '', member_ids: [], scenario_ids: [] }), 400, 'validation_failed');
    await admin.updateGroup(g.id, { name: 'B반', member_ids: [u.id], scenario_ids: [ids.gabriel, ids.noah] });
    const t = browser();
    await loginAs(t, 'Haneul', 'efgh5678');
    await t.startSession({ scenario_id: ids.gabriel });
    await admin.deleteUser(u.id);
    await admin.deleteGroup(g.id);
    await rejects(admin.deleteGroup(g.id), 404, 'not_found');

    expect(rows().map(r => [r.action, r.target, r.meta])).toEqual([
      ['user.create', u.id, { nickname: 'Haneul' }],
      ['user.password_reset', u.id, { nickname: 'Haneul' }],
      ['group.create', g.id, { name: 'A반', member_count: 1, scenario_count: 1 }],
      ['group.update', g.id, { name: 'B반', member_count: 1, scenario_count: 2 }],
      ['user.delete', u.id, { nickname: 'Haneul', session_count: 1 }],
      ['group.delete', g.id, { name: 'B반', member_count: 0, scenario_count: 2 }],
    ]);
    for (const r of rows()) expect(S.AuditEntry.parse(r)).toMatchObject({ actor_id: adminId, created_at: T0 });
    const json = JSON.stringify(rows());
    for (const s of [PW, 'efgh5678', 'sha256$', 'updated_at']) expect(json).not.toContain(s);
  });
});
