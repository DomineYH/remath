// A-4 (part): the five samples load published with compiled prompts, getScenarioPrompt = compileScenario. A-10 (part): getProviders.
import * as S from '@remath/shared';
import { compileScenario, TEMPLATES } from '@remath/prompts';
import seoyeon from '@remath/seed/scenarios/seoyeon.json';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ApiError } from '../types.ts';
import { createMockApi, type MockOptions } from './index.ts';
import { memoryStorage, seedDb, Store } from './store.ts';

const T0 = '2026-10-28T00:00:00.000Z';
async function admin() {
  const store = new Store(memoryStorage(), () => seedDb(T0));
  const api = createMockApi({ realm: 'admin', store, now: () => T0, adminPassword: 'Admin1234' });
  await api.adminLogin({ nickname: 'admin', password: 'Admin1234' });
  return api;
}

describe('sample scenarios (H-38, G-33)', () => {
  it('list cards: names, language, misconception and classification counts, no groups', async () => {
    const list = await (await admin()).listScenarios();
    for (const s of list) expect(S.ScenarioSummary.strict().parse(s)).toEqual(s);
    expect(list.map(s => [s.name, s.lang, s.misconception_count, s.classification_count.leverage, s.classification_count.object, s.groups.length, s.session_count]))
      .toEqual([['가브리엘', 'ko', 3, 4, 9, 0, 0], ['Noah', 'en', 4, 4, 9, 0, 0], ['지우', 'ko', 3, 4, 9, 0, 0], ['하준', 'ko', 3, 0, 0, 0, 0], ['서연', 'ko', 3, 4, 9, 0, 0]]);
  });
  it('getScenario returns the stored ScenarioInput with both editions', async () => {
    const api = await admin(), id = (await api.listScenarios()).find(s => s.slug === 'seoyeon')!.id;
    const s = await api.getScenario(id);
    expect(S.ScenarioAdmin.parse(s)).toBeTruthy();
    expect(S.ScenarioInput.parse(s)).toEqual(S.ScenarioInput.parse(seoyeon));
    expect(s).not.toHaveProperty('compiled_prompt');
  });
  it('getScenarioPrompt = compileScenario of the active language edition', async () => {
    const api = await admin(), list = await api.listScenarios();
    for (const { id } of list) {
      const s = await api.getScenario(id);
      expect(await api.getScenarioPrompt(id)).toEqual(compileScenario(s, s.translations[s.lang], s.lang, TEMPLATES));
    }
    const hajun = list.find(s => s.slug === 'hajun')!;
    expect((await api.getScenarioPrompt(hajun.id)).analysis).toBeNull();
  });
  it('unknown id → 404; teacher realm → 401', async () => {
    const api = await admin();
    await expect(api.getScenarioPrompt('00000000-0000-4000-8000-0000000000ff')).rejects.toSatisfy(e => e instanceof ApiError && e.status === 404);
    const teacher = createMockApi({ realm: 'teacher', store: new Store(memoryStorage(), () => seedDb(T0)), now: () => T0 });
    await expect(teacher.getProviders()).rejects.toSatisfy(e => e instanceof ApiError && e.status === 401);
  });
});

describe('providers (A-10 part, D-20)', () => {
  it('getProviders passes ProvidersFile with ticket 18 contents', async () => {
    const p = S.ProvidersFile.parse(await (await admin()).getProviders());
    expect([p.openai.models.length, p.anthropic.models.length, p.gemini.models.length]).toEqual([7, 4, 4]);
    expect(p.gemini.models.map(m => m.id)).not.toContain('gemini-3.8-pro');
    expect(p.openai.models.flatMap(m => m.efforts)).not.toContain('minimal');
    expect(p.openai.models.find(m => m.id === 'gpt-5.5')!.efforts).not.toContain('max');
  });
});

// ---- A-4 admin scenarios (#26): create/update → draft, review c1–c7, publish 422 ×2 / compiled, delete 409; A-8 scenario.* rows.
const SEO = S.ScenarioInput.parse(seoyeon);
type Input = typeof SEO;
const PW = 'abcd1234';
async function env(extra: Partial<MockOptions> = {}) {
  const store = new Store(memoryStorage(), () => seedDb(T0));
  const mk = (realm: 'teacher' | 'admin') => createMockApi({ realm, store, now: () => T0, adminPassword: 'Admin1234', ...extra });
  const a = mk('admin'), teacher = mk('teacher');
  await a.adminLogin({ nickname: 'admin', password: 'Admin1234' });
  return { store, admin: a, teacher, adminId: (await a.adminMe()).id };
}
async function rejects(p: Promise<unknown>, status: number, code: string): Promise<ApiError> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect([(e as ApiError).status, (e as ApiError).code]).toEqual([status, code]);
    return e as ApiError;
  }
  throw new Error(`expected ${status} ${code}`);
}
const ALL = ['m1', 'm2', 'm3', 'm4'] as const;
const ko = (patch: Partial<Input['translations']['ko']>): Input => ({ ...SEO, translations: { ...SEO.translations, ko: { ...SEO.translations.ko, ...patch } } });

describe('A-4 create and update', () => {
  it('createScenario → draft with a server slug and no compiled prompt; getScenario returns both editions', async () => {
    const { admin } = await env();
    const s = await admin.createScenario(SEO);
    expect(S.ScenarioAdmin.strict().parse(s)).toMatchObject({ status: 'draft', groups: [], session_count: 0, created_at: T0 });
    expect(s.slug).toMatch(/^[a-z0-9-]+$/);
    expect((await admin.listScenarios()).map(x => x.slug)).not.toContain(undefined);
    expect(new Set((await admin.listScenarios()).map(x => x.slug)).size).toBe(6);
    expect(S.ScenarioInput.parse(await admin.getScenario(s.id))).toEqual(SEO);
    expect(await admin.getScenarioPrompt(s.id)).toEqual(compileScenario(SEO, SEO.translations.ko, 'ko', TEMPLATES));
  });
  it('misconception counts must align across both editions and internal → 400', async () => {
    const { admin } = await env();
    await rejects(admin.createScenario(ko({ misconceptions: SEO.translations.ko.misconceptions.slice(1) })), 400, 'validation_failed');
    expect(await admin.listScenarios()).toHaveLength(5);
  });
  it('PUT on a published scenario → draft, compiled prompt dropped; the teacher can no longer start it (403) but the admin can', async () => {
    const { admin, teacher, store } = await env();
    const id = (await admin.listScenarios()).find(s => s.slug === 'seoyeon')!.id;
    const me = await teacher.signup({ nickname: 'Haneul', password: PW });
    await admin.createGroup({ name: 'A', member_ids: [me.id], scenario_ids: [id] });
    const s = await admin.updateScenario(id, ko({ name: '서연이' }));
    expect([s.status, s.slug, s.translations.ko.name]).toEqual(['draft', 'seoyeon', '서연이']);
    expect(store.db.scenarios.find(x => x.id === id)!.compiled_prompt).toBeNull();
    expect((await teacher.getPractice()).scenarios).toEqual([]);
    await rejects(teacher.startSession({ scenario_id: id }), 403, 'forbidden');
    expect((await admin.startSession({ scenario_id: id })).turns[0].text).toBe(SEO.translations.ko.greet);
    await rejects(admin.updateScenario(crypto.randomUUID(), SEO), 404, 'not_found');
  });
});

describe('A-4 review c1–c7 on the active edition', () => {
  const statuses = (r: z.infer<typeof S.ReviewResult>) => Object.fromEntries(r.auto.map(c => [c.id, c.status]));
  it('Seoyeon passes all seven; no classification → c6 INFO and still publishable', async () => {
    const { admin } = await env();
    const r = await admin.reviewScenario((await admin.createScenario(SEO)).id);
    expect(S.ReviewResult.strict().parse(r)).toEqual({ auto: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'].map(id => ({ id, status: 'pass' })), publishable: true });
    const none = await admin.reviewScenario((await admin.createScenario({ ...SEO, classification: { leverage: [], object: [] } })).id);
    expect([statuses(none).c6, none.publishable]).toEqual(['info', true]);
  });
  const breakers: [string, Input][] = [
    ['c1', { ...SEO, internal: { ...SEO.internal, baseline: '' } }],
    ['c2', ko({ misconceptions: SEO.translations.ko.misconceptions.map((m, i) => i === 2 ? { ...m, kw: '' } : m) })],
    ['c3', ko({ t3: '' })],
    ['c4', ko({ confused: [] })],
    ['c5', ko({ misconceptions: SEO.translations.ko.misconceptions.map((m, i) => i ? m : { ...m, c: '최소공배수로 바꾸면 돼요.' }) })],
    ['c6', { ...SEO, classification: { ...SEO.classification, leverage: SEO.classification.leverage.map((r, i) => i ? r : { ...r, desc: '' }) } }],
  ];
  for (const [id, input] of breakers) {
    it(`${id} FAIL input → only ${id} fails, not publishable`, async () => {
      const { admin } = await env();
      const r = await admin.reviewScenario((await admin.createScenario(input)).id);
      expect(Object.entries(statuses(r)).filter(([, v]) => v === 'fail').map(([k]) => k)).toEqual([id]);
      expect(r.publishable).toBe(false);
    });
  }
  it('c7 FAIL when the two template editions differ in structure', async () => {
    const broken = { ...TEMPLATES, mentor: { ...TEMPLATES.mentor, en: TEMPLATES.mentor.en + '\n{{EXTRA_KEY}}' } };
    const { admin } = await env({ templates: broken });
    const r = await admin.reviewScenario((await admin.createScenario(SEO)).id);
    expect([statuses(r).c7, r.publishable]).toEqual(['fail', false]);
  });
  it('judges the active edition: an empty English t1 fails c3 only once lang is en', async () => {
    const { admin } = await env();
    const enBroken = { ...SEO, translations: { ...SEO.translations, en: { ...SEO.translations.en, t1: '' } } };
    expect(statuses(await admin.reviewScenario((await admin.createScenario(enBroken)).id)).c3).toBe('pass');
    expect(statuses(await admin.reviewScenario((await admin.createScenario({ ...enBroken, lang: 'en' })).id)).c3).toBe('fail');
    await rejects(admin.reviewScenario(crypto.randomUUID()), 404, 'not_found');
  });
});

describe('A-4 publish', () => {
  it('422 review_failed with the ReviewResult in details: when a check fails, and when fewer than four confirmations', async () => {
    const { admin } = await env();
    const bad = await admin.createScenario(ko({ t2: '' }));
    const e1 = await rejects(admin.publishScenario(bad.id, { confirmed: [...ALL] }), 422, 'review_failed');
    expect(S.ReviewResult.parse(e1.body.error.details)).toMatchObject({ publishable: false });
    const good = await admin.createScenario(SEO);
    const e2 = await rejects(admin.publishScenario(good.id, { confirmed: ['m1', 'm2', 'm3', 'm3'] }), 422, 'review_failed');
    expect(S.ReviewResult.parse(e2.body.error.details)).toMatchObject({ publishable: true });
    expect((await admin.getScenario(good.id)).status).toBe('draft');
    await rejects(admin.publishScenario(crypto.randomUUID(), { confirmed: [...ALL] }), 404, 'not_found');
  });
  it('success → published, the compiled prompt is stored, getScenarioPrompt = compileScenario of the active edition', async () => {
    const { admin, store } = await env();
    const en = { ...SEO, lang: 'en' as const };
    const s = await admin.publishScenario((await admin.createScenario(en)).id, { confirmed: [...ALL] });
    expect(S.ScenarioAdmin.strict().parse(s).status).toBe('published');
    const expected = compileScenario(SEO, SEO.translations.en, 'en', TEMPLATES);
    expect(store.db.scenarios.find(x => x.id === s.id)!.compiled_prompt).toEqual(expected);
    expect(await admin.getScenarioPrompt(s.id)).toEqual(expected);
    expect(expected.student).toContain(SEO.translations.en.name);
  });
});

describe('A-4 delete', () => {
  it('409 scenario_has_sessions with details.session_count; without records it is removed, also from groups', async () => {
    const { admin } = await env();
    const used = await admin.createScenario(SEO);
    await admin.endSession((await admin.startSession({ scenario_id: used.id })).session.id);
    const e = await rejects(admin.deleteScenario(used.id), 409, 'scenario_has_sessions');
    expect(e.body.error.details).toEqual({ session_count: 1 });
    expect((await admin.listScenarios()).map(s => s.id)).toContain(used.id);
    const fresh = await admin.createScenario(SEO);
    const g = await admin.createGroup({ name: 'A', member_ids: [], scenario_ids: [fresh.id] });
    await admin.deleteScenario(fresh.id);
    await rejects(admin.getScenario(fresh.id), 404, 'not_found');
    expect((await admin.listGroups()).find(x => x.id === g.id)!.scenarios).toEqual([]);
    await rejects(admin.deleteScenario(fresh.id), 404, 'not_found');
  });
});

describe('A-8 audit rows for scenario.*', () => {
  it('one row after each successful write with {slug} (publish adds lang); failed writes leave none', async () => {
    const { admin, store, adminId } = await env();
    const rows = () => store.db.audit_log.filter(r => r.action.startsWith('scenario.'));
    const s = await admin.createScenario(SEO);
    await rejects(admin.createScenario(ko({ misconceptions: [] })), 400, 'validation_failed');
    await admin.updateScenario(s.id, { ...SEO, lang: 'en' });
    await rejects(admin.publishScenario(s.id, { confirmed: ['m1'] }), 422, 'review_failed');
    await admin.publishScenario(s.id, { confirmed: [...ALL] });
    await admin.endSession((await admin.startSession({ scenario_id: s.id })).session.id);
    await rejects(admin.deleteScenario(s.id), 409, 'scenario_has_sessions');
    const d = await admin.createScenario(SEO);
    await admin.deleteScenario(d.id);
    expect(rows().map(r => [r.action, r.target, r.meta])).toEqual([
      ['scenario.create', s.id, { slug: s.slug }],
      ['scenario.update', s.id, { slug: s.slug }],
      ['scenario.publish', s.id, { slug: s.slug, lang: 'en' }],
      ['scenario.create', d.id, { slug: d.slug }],
      ['scenario.delete', d.id, { slug: d.slug }],
    ]);
    for (const r of rows()) expect(S.AuditEntry.parse(r)).toMatchObject({ actor_id: adminId, created_at: T0 });
    expect(JSON.stringify(rows())).not.toContain('updated_at');
  });
});
