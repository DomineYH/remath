// 시드 (D-16): 행 모양·게시+컴파일본·멱등성을 메모리 Data API 스텁으로 고정한다. 실 DB 2회 실행은 수동(T-4).
import { compileScenario, TEMPLATES } from '@remath/prompts';
import { ScenarioInput } from '@remath/shared';
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.ts';
import { readSamples, sampleRows, seed } from './seed.ts';

type Row = Record<string, unknown>;
// 0001 의 unique 중 시드가 부딪히는 것만. users 는 users_single_admin(관리자 1행)이라 teacher 는 겹쳐도 된다.
const UNIQUE: Record<string, string> = { users: 'role', ai_settings: 'role', scenarios: 'slug' };

/** seed.ts 가 쓰는 supabase-js 빌더만. failOn = 그 테이블의 insert 를 실패시킨다. */
function fakeDb(t: Record<string, Row[]>, failOn?: string) {
  const from = (table: string) => {
    let op = 'select', values: Row[] = [], ignore = false, mode: 'many' | 'one' | 'maybe' = 'many';
    const filters: ((r: Row) => boolean)[] = [];
    const run = async () => {
      const rows = t[table] ??= [];
      let out: Row[];
      if (op === 'insert' || op === 'upsert') {
        if (failOn === table) return { data: null, error: { code: 'XX000', message: 'injected failure' } };
        const key = UNIQUE[table];
        out = [];
        for (const v of values) {
          if (key && v[key] !== 'teacher' && rows.some(r => r[key] === v[key])) {
            if (ignore) continue;
            return { data: null, error: { code: '23505', message: 'duplicate key' } };
          }
          const r = { id: crypto.randomUUID(), ...structuredClone(v) };
          rows.push(r); out.push(r);
        }
      } else {
        out = rows.filter(r => filters.every(f => f(r)));
        if (op === 'delete') t[table] = rows.filter(r => !out.includes(r));
      }
      const data = mode === 'many' ? out : out[0] ?? null;
      return mode === 'one' && !data ? { data: null, error: { code: 'PGRST116', message: 'no rows' } } : { data, error: null };
    };
    const b = {
      select: () => b,
      insert: (v: Row | Row[]) => { op = 'insert'; values = [v].flat(); return b; },
      upsert: (v: Row[], o: { ignoreDuplicates?: boolean }) => { op = 'upsert'; values = v; ignore = !!o.ignoreDuplicates; return b; },
      delete: () => { op = 'delete'; return b; },
      eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return b; },
      in: (c: string, v: unknown[]) => { filters.push(r => v.includes(r[c])); return b; },
      single: () => { mode = 'one'; return b; }, maybeSingle: () => { mode = 'maybe'; return b; },
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => run().then(ok, ko),
    };
    return b;
  };
  return { from } as unknown as Db;
}

const PW = 'admin1234';
const samples = readSamples();

describe('seed (D-16)', () => {
  it('reads the five sample files by slug', () => {
    expect(Object.keys(samples)).toEqual(['gabriel', 'hajun', 'jiwoo', 'noah', 'seoyeon']);
  });

  it('turns a sample into a published scenario with the publish-time compiled prompt and two translations', () => {
    const { scenario, translations } = sampleRows('gabriel', samples.gabriel);
    const s = ScenarioInput.parse(samples.gabriel);
    expect(scenario).toMatchObject({ slug: 'gabriel', status: 'published', lang: s.lang, internal: s.internal, classification: s.classification });
    expect(scenario.compiled_prompt).toEqual(compileScenario(s, s.translations[s.lang], s.lang, TEMPLATES));
    expect(scenario).not.toHaveProperty('translations');
    expect(translations).toEqual([{ lang: 'ko', ...s.translations.ko }, { lang: 'en', ...s.translations.en }]);
  });

  it('empty DB: one argon2id admin and three ai_settings rows, no samples without --with-samples', async () => {
    const t: Record<string, Row[]> = {};
    const done = await seed(fakeDb(t), { adminPassword: PW });
    expect(done).toEqual({ admin: 'inserted', ai_settings: ['student', 'mentor', 'analysis'], scenarios: [], skipped_scenarios: [] });
    expect(t.users).toHaveLength(1);
    expect(t.users[0]).toMatchObject({ nickname: 'admin', role: 'admin' });
    expect(String(t.users[0].password_hash)).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(String(t.users[0].password_hash), PW)).toBe(true);
    expect(t.ai_settings).toEqual([
      expect.objectContaining({ role: 'student', key_source: 'own' }),
      expect.objectContaining({ role: 'mentor', key_source: 'student' }),
      expect.objectContaining({ role: 'analysis', key_source: 'student' }),
    ]);
    expect(t.scenarios ?? []).toEqual([]);
  });

  it('--with-samples: 5 scenarios and 10 translations; a second run changes nothing', async () => {
    const t: Record<string, Row[]> = {};
    const first = await seed(fakeDb(t), { adminPassword: PW, samples });
    expect(first.scenarios).toEqual(Object.keys(samples));
    expect(t.scenarios).toHaveLength(5);
    expect(t.scenario_translations).toHaveLength(10);
    for (const s of t.scenarios) expect(t.scenario_translations.filter(tr => tr.scenario_id === s.id).map(tr => tr.lang)).toEqual(['ko', 'en']);

    const before = structuredClone(t);
    const second = await seed(fakeDb(t), { adminPassword: 'other999', samples });
    expect(second).toEqual({ admin: 'skipped', ai_settings: [], scenarios: [], skipped_scenarios: Object.keys(samples) });
    expect(t).toEqual(before);   // 관리자 비밀번호도 그대로
  });

  it('skips only the slugs that exist and leaves an existing admin and ai_settings untouched', async () => {
    const t: Record<string, Row[]> = {
      users: [{ id: 'a', nickname: 'admin', role: 'admin', password_hash: 'kept' }],
      ai_settings: [{ role: 'mentor', key_source: 'own' }],
      scenarios: [{ id: 's', slug: 'noah', status: 'draft' }],
    };
    const done = await seed(fakeDb(t), { adminPassword: PW, samples });
    expect(done).toEqual({ admin: 'skipped', ai_settings: ['student', 'analysis'], scenarios: ['gabriel', 'hajun', 'jiwoo', 'seoyeon'], skipped_scenarios: ['noah'] });
    expect(t.users).toEqual([{ id: 'a', nickname: 'admin', role: 'admin', password_hash: 'kept' }]);
    expect(t.ai_settings.find(r => r.role === 'mentor')).toEqual({ role: 'mentor', key_source: 'own' });
    expect(t.scenarios.find(r => r.slug === 'noah')).toEqual({ id: 's', slug: 'noah', status: 'draft' });
  });

  it('a failed translation insert removes its scenario so a rerun can insert it', async () => {
    const t: Record<string, Row[]> = {};
    await expect(seed(fakeDb(t, 'scenario_translations'), { adminPassword: PW, samples })).rejects.toMatchObject({ code: 'XX000' });
    expect(t.scenarios).toEqual([]);
    await seed(fakeDb(t), { adminPassword: PW, samples });
    expect(t.scenarios).toHaveLength(5);
  });

  it('an invalid sample file inserts nothing', async () => {
    const t: Record<string, Row[]> = {};
    await expect(seed(fakeDb(t), { adminPassword: PW, samples: { ...samples, broken: { lang: 'fr' } } })).rejects.toThrow();
    expect(t).toEqual({});
  });
});
