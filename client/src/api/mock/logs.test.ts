// A-7 (CSV), A-10 (AI settings · providers), A-8 (every admin write the mock can make leaves one audit row), against the mock API only.
import * as S from '@remath/shared';
import { describe, expect, it } from 'vitest';
import { ApiError, type Api } from '../types.ts';
import { createMockApi } from './index.ts';
import { memoryStorage, seedDb, Store } from './store.ts';

const T0 = '2026-10-28T00:00:00.000Z';
const ADMIN_PW = 'Admin1234';
const PW = 'abcd1234';
const HEADER = 'session_id,started_at,nickname,scenario,lang,seq,speaker,text,leverage,object,trigger';

async function setup() {
  const store = new Store(memoryStorage(), () => seedDb(T0));
  let tick = 0;   // every call is one second later, so "newest first" is observable
  const now = () => new Date(Date.parse(T0) + 1000 * tick++).toISOString();
  const mk = (realm: 'teacher' | 'admin') => createMockApi({ realm, store, now, adminPassword: ADMIN_PW, cookies: { teacher: null, admin: null } });
  const admin = mk('admin');
  await admin.adminLogin({ nickname: 'admin', password: ADMIN_PW });
  const ids = Object.fromEntries((await admin.listScenarios()).map(s => [s.slug, s.id]));
  /** A new teacher (own browser) in a group with `slugs`. */
  const teacher = async (nickname: string, slugs: string[]) => {
    const t = mk('teacher'), me = await t.signup({ nickname, password: PW });
    await admin.createGroup({ name: nickname, member_ids: [me.id], scenario_ids: slugs.map(s => ids[s]) });
    return { t, me };
  };
  return { store, admin, ids, teacher };
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
const say = async (t: Api, sid: string, text: string) => drain(t.sendTurn(sid, { text }));
const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const lines = async (b: Blob) => new TextDecoder().decode(await bytes(b)).split('\r\n');   // TextDecoder strips the BOM

describe('A-7 sessions CSV', () => {
  it('Blob with a UTF-8 BOM, the C13 header, one row per turn, newest session first, filters by user and scenario', async () => {
    const { admin, ids, teacher } = await setup();
    const a = await teacher('Haneul', ['gabriel', 'noah']), b = await teacher('Bora', ['gabriel']);
    const s1 = await a.t.startSession({ scenario_id: ids.gabriel });
    await say(a.t, s1.session.id, '왜 그렇게 생각했어, "정말"?');    // comma + quotes must survive
    await a.t.endSession(s1.session.id);
    const s2 = await a.t.startSession({ scenario_id: ids.noah });
    const s3 = await b.t.startSession({ scenario_id: ids.gabriel });

    const all = await admin.downloadSessionsCsv({});
    expect(all).toBeInstanceOf(Blob);
    expect([...(await bytes(all)).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const rows = await lines(all);
    const turns = async (sid: string) => (await admin.getAdminSession(sid)).turns;
    const t1 = await turns(s1.session.id), t2 = await turns(s2.session.id), t3 = await turns(s3.session.id);
    expect(rows[0]).toBe(HEADER);
    expect(rows).toHaveLength(1 + t1.length + t2.length + t3.length);
    expect(rows.slice(1).map(r => r.split(',')[0].replace(/"/g, ''))).toEqual([...t3.map(() => s3.session.id), ...t2.map(() => s2.session.id), ...t1.map(() => s1.session.id)]);
    const teacherRow = rows.find(r => r.includes('"정말"'.replace(/"/g, '""')));
    expect(teacherRow).toBe([s1.session.id, s1.session.started_at, 'Haneul', '가브리엘', 'ko', 2, 'teacher', '왜 그렇게 생각했어, ""정말""?', t1[1].leverage ?? '', t1[1].object ?? '', ''].map(v => `"${v}"`).join(','));

    expect(await lines(await admin.downloadSessionsCsv({ user_id: a.me.id }))).toHaveLength(1 + t1.length + t2.length);
    expect(await lines(await admin.downloadSessionsCsv({ scenario_id: ids.gabriel }))).toHaveLength(1 + t1.length + t3.length);
    expect(await lines(await admin.downloadSessionsCsv({ user_id: b.me.id, scenario_id: ids.noah }))).toEqual([HEADER]);
    await rejects(admin.downloadSessionsCsv({ user_id: 'nope' }), 400, 'validation_failed');
    await rejects(createMockApi({ realm: 'teacher', store: new Store(memoryStorage(), () => seedDb(T0)), adminPassword: ADMIN_PW }).downloadSessionsCsv({}), 401, 'unauthorized');
  });
  it('listAdminSessions uses the same filter, newest first', async () => {
    const { admin, ids, teacher } = await setup();
    const a = await teacher('Haneul', ['gabriel', 'noah']);
    const s1 = await a.t.startSession({ scenario_id: ids.gabriel }); await a.t.endSession(s1.session.id);
    const s2 = await a.t.startSession({ scenario_id: ids.noah });
    expect((await admin.listAdminSessions({})).map(r => r.id)).toEqual([s2.session.id, s1.session.id]);
    expect((await admin.listAdminSessions({ scenario_id: ids.noah })).map(r => r.id)).toEqual([s2.session.id]);
  });
});

const ANT = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123WXYZ', OAI = 'sk-proj-abcdefghijklmnopqrstuv9876', GEM = 'AIzaSyabcdefghijklmnopqrstuvwxyz012345GGGG';
describe('A-10 AI settings', () => {
  it('the key prefix picks the provider; only the masked key and its date are stored and returned', async () => {
    const { admin, store } = await setup();
    const a = await admin.updateAiRole('student', { key_source: 'own', api_key: ANT, model: 'claude-haiku-5-5', effort: 'low' });
    expect(S.AiRoleSetting.strict().parse(a)).toMatchObject({ role: 'student', key_source: 'own', provider: 'anthropic', key_masked: 'sk-ant-…WXYZ', model: 'claude-haiku-5-5', effort: 'low' });
    expect(a.key_added_at).toMatch(/^2026-10-28T/);
    expect((await admin.updateAiRole('analysis', { key_source: 'own', api_key: OAI, model: 'gpt-6-astra', effort: 'high' })).key_masked).toBe('sk-proj-…9876');
    expect((await admin.updateAiRole('mentor', { key_source: 'own', api_key: GEM, model: 'gemini-4-argon', effort: null })).provider).toBe('gemini');
    expect((await admin.updateAiRole('mentor', { key_source: 'own', api_key: 'sk-plainopenai0000LAST', model: 'gpt-5.5', effort: null })).provider).toBe('openai');
    expect(await admin.getAiSettings()).toEqual(S.AiSettings.parse(await admin.getAiSettings()));
    const json = JSON.stringify(store.db) + JSON.stringify(store.storage.getItem('remath.mock.v1'));
    for (const k of [ANT, OAI, GEM, 'sk-plainopenai0000LAST']) expect(json).not.toContain(k);
  });
  it('omitting api_key keeps the key; sharing uses the source key provider; unknown prefix and bad sources → 400', async () => {
    const { admin } = await setup();
    const first = await admin.updateAiRole('student', { key_source: 'own', api_key: ANT, model: 'claude-haiku-5-5', effort: 'low' });
    expect(await admin.updateAiRole('student', { key_source: 'own', model: 'claude-opus-5-5', effort: 'max' })).toMatchObject({ provider: 'anthropic', key_masked: first.key_masked, key_added_at: first.key_added_at, model: 'claude-opus-5-5' });
    expect(await admin.updateAiRole('mentor', { key_source: 'student', model: 'claude-sonnet-5-5', effort: 'medium' })).toMatchObject({ key_source: 'student', provider: 'anthropic', key_masked: null });
    const before = await admin.getAiSettings();
    await rejects(admin.updateAiRole('analysis', { key_source: 'own', api_key: 'pk-unknown-0000000000', model: 'x', effort: null }), 400, 'validation_failed');
    await rejects(admin.updateAiRole('analysis', { key_source: 'own', model: 'gpt-5.5', effort: null }), 400, 'validation_failed');           // no key yet
    await rejects(admin.updateAiRole('analysis', { key_source: 'analysis', model: 'gpt-5.5', effort: null }), 400, 'validation_failed');      // itself
    await rejects(admin.updateAiRole('analysis', { key_source: 'mentor', model: 'claude-opus-5-5', effort: null }), 400, 'validation_failed'); // mentor shares, has no key of its own
    await rejects(admin.updateAiRole('analysis', { key_source: 'student', api_key: OAI, model: 'gpt-5.5', effort: null }), 400, 'validation_failed'); // a key only with own
    expect(await admin.getAiSettings()).toEqual(before);
    await rejects(admin.updateAiRole('teacher' as never, { key_source: 'own', model: 'gpt-5.5', effort: null }), 404, 'not_found');
  });
  it('invalid_effort on three paths: listed model → its set, custom model → the provider set, null always passes', async () => {
    const { admin } = await setup();
    await admin.updateAiRole('analysis', { key_source: 'own', api_key: OAI, model: 'gpt-6-astra', effort: 'low' });
    await rejects(admin.updateAiRole('analysis', { key_source: 'own', model: 'gpt-5.5', effort: 'max' }), 400, 'invalid_effort');        // gpt-5.5 has no max
    await rejects(admin.updateAiRole('analysis', { key_source: 'own', model: 'gpt-6-astra', effort: 'none' }), 400, 'invalid_effort');
    expect((await admin.updateAiRole('analysis', { key_source: 'own', model: 'gpt-6.1-terra', effort: 'minimal' })).model).toBe('gpt-6.1-terra'); // custom: OpenAI set
    await admin.updateAiRole('student', { key_source: 'own', api_key: GEM, model: 'gemini-4-argon', effort: 'low' });
    await rejects(admin.updateAiRole('student', { key_source: 'own', model: 'gemini-9-custom', effort: 'xhigh' }), 400, 'invalid_effort'); // not in the Gemini set
    for (const model of ['gemini-4-argon', 'gemini-9-custom']) expect((await admin.updateAiRole('student', { key_source: 'own', model, effort: null })).effort).toBeNull();
    await rejects(admin.updateAiRole('student', { key_source: 'own', model: 'gemini-4-argon', effort: 'turbo' as never }), 400, 'validation_failed');
  });
});

describe('A-8 audit log: every write the mock can make', () => {
  it('one row per successful write with ticket-20 target·meta; reads, turns and failed writes leave none; no secrets, no updated_at', async () => {
    const { admin, store, ids, teacher } = await setup();
    const adminId = (await admin.adminMe()).id;
    const { t, me } = await teacher('Haneul', ['gabriel']);                       // signup: no row; createGroup: group.create
    await rejects(t.login({ nickname: 'Haneul', password: 'wrong999' }), 401, 'invalid_credentials');
    await rejects(t.changePassword({ current: 'wrong999', next: 'efgh5678' }), 401, 'invalid_credentials');
    await t.changePassword({ current: PW, next: 'efgh5678' });
    const s = await t.startSession({ scenario_id: ids.gabriel });
    await say(t, s.session.id, '비밀스러운 발화 텍스트');
    await t.endSession(s.session.id);
    await rejects(createMockApi({ realm: 'admin', store, adminPassword: ADMIN_PW, cookies: { teacher: null, admin: null } }).adminLogin({ nickname: 'admin', password: 'nope1234' }), 401, 'invalid_credentials');
    await admin.adminChangePassword({ current: ADMIN_PW, next: 'Admin5678' });
    const u = await admin.createUser({ nickname: 'Bora', password: PW });
    await rejects(admin.createUser({ nickname: 'bora', password: PW }), 409, 'nickname_taken');
    await admin.resetUserPassword(u.id, { password: 'zxcv0987' });
    const g = (await admin.listGroups())[0];
    await admin.updateGroup(g.id, { name: 'A반', member_ids: [me.id, u.id], scenario_ids: [ids.gabriel] });
    await admin.updateAiRole('student', { key_source: 'own', api_key: ANT, model: 'claude-haiku-5-5', effort: 'low' });
    await rejects(admin.updateAiRole('student', { key_source: 'own', model: 'claude-haiku-5-5', effort: 'none' }), 400, 'invalid_effort');
    await rejects(admin.updateAiRole('mentor', { key_source: 'own', api_key: 'pk-unknown-0000000000', model: 'x', effort: null }), 400, 'validation_failed');
    await admin.updateAiRole('mentor', { key_source: 'student', model: 'claude-sonnet-5-5', effort: null });
    await admin.downloadSessionsCsv({}); await admin.listAdminSessions({}); await admin.getAdminSession(s.session.id); await admin.getAiSettings();
    await admin.deleteUser(me.id);
    await admin.deleteGroup(g.id);

    const rows = store.db.audit_log;
    expect(rows.map(r => [r.action, r.actor_id, r.target, r.meta])).toEqual([
      ['group.create', adminId, g.id, { name: 'Haneul', member_count: 1, scenario_count: 1 }],
      ['auth.login_failed', null, 'Haneul', { realm: 'teacher', reason: 'invalid_credentials' }],
      ['auth.password_change', me.id, me.id, { realm: 'teacher' }],
      ['auth.login_failed', null, 'admin', { realm: 'admin', reason: 'invalid_credentials' }],
      ['auth.password_change', adminId, adminId, { realm: 'admin' }],
      ['user.create', adminId, u.id, { nickname: 'Bora' }],
      ['user.password_reset', adminId, u.id, { nickname: 'Bora' }],
      ['group.update', adminId, g.id, { name: 'A반', member_count: 2, scenario_count: 1 }],
      ['ai.update', adminId, 'student', { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'low', key_source: 'own', key_masked: 'sk-ant-…WXYZ', key_changed: true }],
      ['ai.update', adminId, 'mentor', { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: null, key_source: 'student', key_masked: null, key_changed: false }],
      ['user.delete', adminId, me.id, { nickname: 'Haneul', session_count: 1 }],
      ['group.delete', adminId, g.id, { name: 'A반', member_count: 1, scenario_count: 1 }],
    ]);
    for (const r of rows) { expect(S.AuditEntry.parse(r)).toEqual(r); expect(r).not.toHaveProperty('updated_at'); }
    const json = JSON.stringify(rows);
    for (const secret of [PW, 'wrong999', 'efgh5678', 'zxcv0987', 'Admin5678', 'nope1234', ANT, 'sha256$', '비밀스러운']) expect(json).not.toContain(secret);
  });
});
