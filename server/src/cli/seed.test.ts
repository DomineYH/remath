// 시드 (D-16): 행 모양·게시+컴파일본·멱등성, 그리고 "넣기만 한다"(지우거나 고치지 않음)를 메모리 Data API 스텁으로 고정한다.
// 실 DB 2회 실행은 수동(T-4).
import { compileScenario, TEMPLATES } from '@remath/prompts';
import { ScenarioInput } from '@remath/shared';
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.ts';
import { readSamples, sampleRows, seed } from './seed.ts';

type Row = Record<string, unknown>;
type T = Record<string, Row[]>;
const err = (code: string, message: string) => ({ data: null, error: { code, message } });

/**
 * seed.ts 가 쓰는 supabase-js 빌더 + 0004 의 save_scenario·publish_scenario(각각 한 트랜잭션).
 * 제약: users_single_admin, ai_settings.role, scenarios.slug, scenario_translations(scenario_id, lang).
 * fail = 실패시킬 지점(`insert:users`, `select:scenarios`, `rpc:save_scenario` …). `lost:<지점>` = 커밋은 되고 응답만 잃음.
 * before(지점) = 그 연산 직전에 끼어들기. from().update/delete 는 부르는 것 자체가 테스트 실패다.
 */
function fakeDb(t: T, o: { fail?: string[]; before?: (point: string) => void } = {}) {
  let clock = 0;
  const now = () => `2026-10-28T00:00:${String(clock++).padStart(2, '0')}Z`;
  const gate = (point: string, commit: () => { data: unknown; error: unknown }) => {
    o.before?.(point);
    if (o.fail?.includes(point)) return err('XX000', `injected ${point} failure`);
    const r = commit();
    return o.fail?.includes(`lost:${point}`) && !r.error ? err('08006', `lost response after ${point}`) : r;
  };
  const from = (table: string) => {
    let op = 'select', cols = '', values: Row[] = [], ignore = false, mode: 'many' | 'one' | 'maybe' = 'many';
    const filters: ((r: Row) => boolean)[] = [];
    const run = async () => gate(`${op === 'upsert' ? 'insert' : op}:${table}`, () => {
      const rows = t[table] ??= [];
      if (op === 'select') {
        // SCENARIO_SELECT 는 번역을 임베드한다(PostgREST: 같은 요청 = 같은 스냅숏). TR_COLS = lang + Translation 필드.
        const embed = (r: Row) => !cols.includes('scenario_translations(') ? r : {
          ...r, group_scenarios: [], sessions: [{ count: 0 }],
          scenario_translations: (t.scenario_translations ?? []).filter(tr => tr.scenario_id === r.id).map(({ id: _id, scenario_id: _s, ...tr }) => tr),
        };
        const out = rows.filter(r => filters.every(f => f(r))).map(r => structuredClone(embed(r)));
        const data = mode === 'many' ? out : out[0] ?? null;
        return mode === 'one' && !data ? err('PGRST116', 'no rows') : { data, error: null };
      }
      const out: Row[] = [];
      for (const v of values) {
        const dup = table === 'users' ? v.role === 'admin' && rows.some(r => r.role === 'admin') : rows.some(r => r.role === v.role);
        if (dup) { if (ignore) continue; return err('23505', 'duplicate key'); }
        const r = { id: crypto.randomUUID(), ...structuredClone(v) };
        rows.push(r); out.push(r);
      }
      return { data: out.map(r => structuredClone(r)), error: null };
    });
    const forbidden = (what: string) => () => { throw new Error(`seed must never ${what} (${table})`); };
    const b = {
      select: (c = '') => { cols = c; return b; },
      insert: (v: Row | Row[]) => { op = 'insert'; values = [v].flat(); return b; },
      upsert: (v: Row[], x: { ignoreDuplicates?: boolean }) => { op = 'upsert'; values = v; ignore = !!x.ignoreDuplicates; return b; },
      update: forbidden('update'), delete: forbidden('delete'),
      eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return b; },
      in: (c: string, v: unknown[]) => { filters.push(r => v.includes(r[c])); return b; },
      single: () => { mode = 'one'; return b; }, maybeSingle: () => { mode = 'maybe'; return b; },
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => run().then(ok, ko),
    };
    return b;
  };
  const rpc = async (name: string, a: Row) => gate(`rpc:${name}`, () => {
    const scenarios = t.scenarios ??= [], translations = t.scenario_translations ??= [];
    if (name === 'save_scenario') {
      const { translations: tr, ...s } = a.p_input as { translations: Record<'ko' | 'en', Row> } & Row;
      if (a.p_slug === null) throw new Error('seed only creates scenarios');
      if (scenarios.some(r => r.slug === a.p_slug)) return err('23505', 'duplicate key value violates unique constraint "scenarios_slug_key"');
      const ts = now();
      scenarios.push({ id: a.p_id, slug: a.p_slug, status: 'draft', compiled_prompt: null, ...structuredClone(s), created_at: ts, updated_at: ts });
      for (const lang of ['ko', 'en'] as const) translations.push({ id: crypto.randomUUID(), scenario_id: a.p_id, lang, ...structuredClone(tr[lang]) });
      return { data: true, error: null };
    }
    if (name === 'publish_scenario') {
      const s = scenarios.find(r => r.id === a.p_id && r.updated_at === a.p_expected_updated_at);
      if (!s) return { data: false, error: null };
      Object.assign(s, { status: 'published', compiled_prompt: structuredClone(a.p_compiled), updated_at: now() });
      return { data: true, error: null };
    }
    throw new Error(`unknown rpc ${name}`);
  });
  return { from, rpc } as unknown as Db;
}

const PW = 'admin1234';
const samples = readSamples();
const SLUGS = Object.keys(samples);
const byId = (rows: Row[] = []) => Object.fromEntries(rows.map(r => [String(r.id), r]));
/** 시드 뒤에도 이전의 모든 행이 같은 값으로 남아 있어야 한다(지우지도 고치지도 않음). */
const expectKept = (before: T, after: T) => {
  for (const [table, rows] of Object.entries(before)) for (const r of rows) expect(byId(after[table])[String(r.id)], `${table} ${r.id}`).toEqual(r);
};

describe('seed (D-16)', () => {
  it('reads the five sample files by slug', () => {
    expect(SLUGS).toEqual(['gabriel', 'hajun', 'jiwoo', 'noah', 'seoyeon']);
  });

  it('a sample becomes the parsed ScenarioInput and the publish-time compiled prompt', () => {
    const s = ScenarioInput.parse(samples.gabriel);
    expect(sampleRows('gabriel', samples.gabriel)).toEqual({ slug: 'gabriel', input: s, compiled: compileScenario(s, s.translations[s.lang], s.lang, TEMPLATES) });
  });

  it('empty DB: one argon2id admin and three ai_settings rows, no samples without --with-samples', async () => {
    const t: T = {};
    expect(await seed(fakeDb(t), { adminPassword: PW })).toEqual({ admin: 'inserted', ai_settings: ['student', 'mentor', 'analysis'], scenarios: [], skipped_scenarios: [] });
    expect(t.users).toHaveLength(1);
    expect(t.users[0]).toMatchObject({ nickname: 'admin', role: 'admin' });
    expect(String(t.users[0].password_hash)).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(String(t.users[0].password_hash), PW)).toBe(true);
    expect(t.ai_settings).toEqual([
      expect.objectContaining({ role: 'student', key_source: 'own' }),
      expect.objectContaining({ role: 'mentor', key_source: 'student' }),
      expect.objectContaining({ role: 'analysis', key_source: 'student' }),
    ]);
    expect(t.scenarios).toBeUndefined();
  });

  it('--with-samples: 5 published scenarios with their compiled prompt and 10 translations; a second run changes nothing', async () => {
    const t: T = {};
    expect((await seed(fakeDb(t), { adminPassword: PW, samples })).scenarios).toEqual(SLUGS);
    expect(t.scenarios.map(s => [s.slug, s.status])).toEqual(SLUGS.map(s => [s, 'published']));
    for (const s of t.scenarios) {
      expect(s.compiled_prompt).toEqual(sampleRows(String(s.slug), samples[String(s.slug)]).compiled);
      expect(t.scenario_translations.filter(tr => tr.scenario_id === s.id).map(tr => tr.lang)).toEqual(['ko', 'en']);
    }

    const before = structuredClone(t);
    expect(await seed(fakeDb(t), { adminPassword: 'other999', samples })).toEqual({ admin: 'skipped', ai_settings: [], scenarios: [], skipped_scenarios: SLUGS });
    expect(t).toEqual(before);   // 관리자 비밀번호도 그대로
  });

  it('an existing slug is skipped untouched whatever its state (draft, edited, even without translations)', async () => {
    const t: T = {
      users: [{ id: 'a', nickname: 'admin', role: 'admin', password_hash: 'kept' }],
      ai_settings: [{ id: 'm', role: 'mentor', key_source: 'own' }],
      scenarios: [{ id: 's1', slug: 'noah', status: 'draft', updated_at: 'x' }, { id: 's2', slug: 'hajun', status: 'published', updated_at: 'y' }],
      scenario_translations: [{ id: 'k', scenario_id: 's1', lang: 'ko', name: 'edited' }],
    };
    const before = structuredClone(t);
    const done = await seed(fakeDb(t), { adminPassword: PW, samples });
    expect(done).toEqual({ admin: 'skipped', ai_settings: ['student', 'analysis'], scenarios: ['gabriel', 'jiwoo', 'seoyeon'], skipped_scenarios: ['hajun', 'noah'] });
    expectKept(before, t);
    expect(t.scenario_translations.filter(r => r.scenario_id === 's1' || r.scenario_id === 's2')).toEqual(before.scenario_translations);
  });

  it('a slug created by someone else between the check and the save is skipped and left alone', async () => {
    const t: T = {};
    let raced = false;
    const before = (point: string) => {
      if (point !== 'rpc:save_scenario' || raced) return;
      raced = true;   // 첫 save 직전에 다른 실행이 gabriel 을 만든다
      t.scenarios = [{ id: 'other', slug: 'gabriel', status: 'published', updated_at: 'z' }];
      t.scenario_translations = [{ id: 'o1', scenario_id: 'other', lang: 'ko' }, { id: 'o2', scenario_id: 'other', lang: 'en' }];
    };
    const done = await seed(fakeDb(t, { before }), { adminPassword: PW, samples });
    expect(done.skipped_scenarios).toEqual(['gabriel']);
    expect(done.scenarios).toEqual(SLUGS.slice(1));
    expect(t.scenarios[0]).toEqual({ id: 'other', slug: 'gabriel', status: 'published', updated_at: 'z' });
    expect(t.scenario_translations.filter(r => r.scenario_id === 'other').map(r => r.id)).toEqual(['o1', 'o2']);
  });

  it('a publish that loses to a concurrent save fails loudly and leaves the newer row as it is', async () => {
    const t: T = {};
    const before = (point: string) => {
      if (point === 'rpc:publish_scenario' && t.scenarios?.length === 1) Object.assign(t.scenarios[0], { updated_at: 'edited', grade: 'admin edit' });
    };
    await expect(seed(fakeDb(t, { before }), { adminPassword: PW, samples })).rejects.toThrow(/sample gabriel was saved as a draft but not published \(changed since it was saved\)/);
    expect(t.scenarios[0]).toMatchObject({ slug: 'gabriel', status: 'draft', grade: 'admin edit', compiled_prompt: null });
  });

  it('an admin save between save_scenario and the read is never published, so unreviewed content never goes live', async () => {
    const t: T = {}, published: Row[] = [];
    const db = fakeDb(t, {
      before: point => {
        // 리뷰의 끼어들기: 저장 직후, 시드가 행+번역을 읽기 전에 관리자가 활성 언어판 이름을 바꿔 저장한다.
        if (point !== 'select:scenarios' || t.scenarios?.length !== 1 || t.scenarios[0].status !== 'draft') return;
        const s = t.scenarios[0];
        Object.assign(s, { updated_at: 'admin-saved' });
        Object.assign(t.scenario_translations.find(r => r.scenario_id === s.id && r.lang === s.lang)!, { name: 'admin edit, not reviewed' });
      },
    });
    const rpc = db.rpc.bind(db);
    (db as unknown as { rpc: typeof rpc }).rpc = ((name: string, a: Row) => { if (name === 'publish_scenario') published.push(a); return rpc(name, a); }) as typeof rpc;
    await expect(seed(db, { adminPassword: PW, samples })).rejects.toThrow(/sample gabriel was saved as a draft but not published \(changed since it was saved\)/);
    expect(published).toEqual([]);
    expect(t.scenarios[0]).toMatchObject({ slug: 'gabriel', status: 'draft', compiled_prompt: null, updated_at: 'admin-saved' });
  });

  it('publishes the compiled prompt of exactly the content it read, with the updated_at it read', async () => {
    const t: T = {}, published: Row[] = [];
    const db = fakeDb(t);
    const rpc = db.rpc.bind(db);
    (db as unknown as { rpc: typeof rpc }).rpc = ((name: string, a: Row) => {
      if (name === 'publish_scenario') {
        const s = t.scenarios.find(r => r.id === a.p_id)!, tr = t.scenario_translations.find(r => r.scenario_id === s.id && r.lang === s.lang)!;
        published.push({ ...a, stored: compileScenario(s as never, tr as never, s.lang as 'ko' | 'en', TEMPLATES), updated_at: s.updated_at });
      }
      return rpc(name, a);
    }) as typeof rpc;
    await seed(db, { adminPassword: PW, samples });
    expect(published).toHaveLength(5);
    for (const p of published) {
      expect(p.p_compiled).toEqual(p.stored);
      expect(p.p_expected_updated_at).toBe(p.updated_at);
    }
  });

  // 실패 지점마다: 실패한 실행도, 이어지는 정상 실행도 아무것도 지우거나 고치지 않는다. 시나리오는 언제나 번역 2행을 가진다.
  const POINTS = ['insert:users', 'insert:ai_settings', 'select:scenarios', 'rpc:save_scenario', 'rpc:publish_scenario'];
  for (const fail of POINTS.flatMap(p => [p, `lost:${p}`])) {
    it(`never deletes or modifies on failure (${fail}), and a rerun only adds`, async () => {
      const t: T = { scenarios: [{ id: 'mine', slug: 'noah', status: 'published', updated_at: 'u' }], scenario_translations: [{ id: 'n1', scenario_id: 'mine', lang: 'ko' }] };
      const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => e.message);
      expect(await outcome(seed(fakeDb(t, { fail: [fail] }), { adminPassword: PW, samples }))).not.toMatch(/must never/);
      const afterFailure = structuredClone(t);
      expect(await outcome(seed(fakeDb(t), { adminPassword: PW, samples }))).not.toMatch(/must never/);
      expectKept(afterFailure, t);
      expect(t.scenarios.find(r => r.id === 'mine')).toEqual({ id: 'mine', slug: 'noah', status: 'published', updated_at: 'u' });
      for (const s of t.scenarios.filter(r => r.id !== 'mine')) expect(t.scenario_translations.filter(r => r.scenario_id === s.id)).toHaveLength(2);
      expect(t.users.filter(u => u.role === 'admin')).toHaveLength(1);
      expect(t.ai_settings.map(r => r.role).sort()).toEqual(['analysis', 'mentor', 'student']);
    });
  }

  it('an unpublished sample (publish failed) is reported and then skipped on rerun, never touched', async () => {
    const t: T = {};
    await expect(seed(fakeDb(t, { fail: ['rpc:publish_scenario'] }), { adminPassword: PW, samples }))
      .rejects.toThrow(/sample gabriel was saved as a draft but not published.*publish it in the admin Scenarios tab/);
    const draft = structuredClone(t.scenarios[0]);
    expect((await seed(fakeDb(t), { adminPassword: PW, samples })).skipped_scenarios).toEqual(['gabriel']);
    expect(t.scenarios[0]).toEqual(draft);
  });

  it('an invalid sample file writes nothing', async () => {
    const t: T = {};
    await expect(seed(fakeDb(t), { adminPassword: PW, samples: { ...samples, broken: { lang: 'fr' } } })).rejects.toThrow();
    expect(t).toEqual({});
  });
});
