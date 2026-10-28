// 시드 CLI (D-16, O-5, M-7, M-8): 관리자 1 + ai_settings 3 + `--with-samples`면 샘플 시나리오 5(게시+컴파일본).
// 멱등: 관리자가 있으면 건너뛰고, 있는 행은 덮어쓰지 않는다. 데모 계정·그룹·기록은 어떤 옵션에도 없다.
// 실행: `npm run db:seed -w server [-- --with-samples]` (deploy.sh 3단계).
import { readdirSync, readFileSync } from 'node:fs';
import { compileScenario, TEMPLATES } from '@remath/prompts';
import { Password, ScenarioInput } from '@remath/shared';
import argon2 from 'argon2';
import { z } from 'zod';
import { createDb, must, type Db } from '../db.ts';
import { main, readEnv } from './main.ts';

// 목 `aiRole` 초기값과 같다(client/src/api/mock/store.ts).
const AI_SETTINGS = [{ role: 'student', key_source: 'own' }, { role: 'mentor', key_source: 'student' }, { role: 'analysis', key_source: 'student' }];

const SAMPLES_DIR = new URL('../../../db/seed/scenarios/', import.meta.url);
/** db/seed/scenarios/*.json → {slug: json}. slug = 파일명(목 store.ts SAMPLES 키와 같다). */
export const readSamples = (): Record<string, unknown> => Object.fromEntries(readdirSync(SAMPLES_DIR).filter(f => f.endsWith('.json')).sort()
  .map(f => [f.slice(0, -'.json'.length), JSON.parse(readFileSync(new URL(f, SAMPLES_DIR), 'utf8'))]));

/** 샘플 1개 → scenarios 행 + scenario_translations 2행. 목 store.ts `sample` 과 같이 게시 상태 + 같은 compileScenario 결과. */
export function sampleRows(slug: string, json: unknown) {
  const { translations, ...s } = ScenarioInput.parse(json);
  return {
    scenario: { ...s, slug, status: 'published', compiled_prompt: compileScenario(s, translations[s.lang], s.lang, TEMPLATES) },
    translations: (['ko', 'en'] as const).map(lang => ({ lang, ...translations[lang] })),
  };
}

export async function seed(db: Db, o: { adminPassword: string; samples?: Record<string, unknown> }) {
  const done = { admin: 'skipped', ai_settings: [] as string[], scenarios: [] as string[], skipped_scenarios: [] as string[] };
  // 파일을 먼저 전부 검증한다: 깨진 샘플 하나 때문에 일부만 들어가지 않게.
  const samples = Object.entries(o.samples ?? {}).map(([slug, json]) => sampleRows(slug, json));

  if (!must(await db.from('users').select('id').eq('role', 'admin').maybeSingle())) {
    must(await db.from('users').insert({ nickname: 'admin', password_hash: await argon2.hash(o.adminPassword), role: 'admin' }));
    done.admin = 'inserted';
  }
  // insert ... on conflict (role) do nothing returning role → 새로 들어간 행만 돌아온다.
  done.ai_settings = must(await db.from('ai_settings').upsert(AI_SETTINGS, { onConflict: 'role', ignoreDuplicates: true }).select('role'))!
    .map((r: { role: string }) => r.role);

  if (!samples.length) return done;
  const existing = new Map((must(await db.from('scenarios').select('id, slug').in('slug', samples.map(r => r.scenario.slug))) as { id: string; slug: string }[])
    .map(r => [r.slug, r.id]));
  const langs = existing.size
    ? must(await db.from('scenario_translations').select('scenario_id, lang').in('scenario_id', [...existing.values()])) as { scenario_id: string; lang: string }[] : [];
  for (const { scenario, translations } of samples) {
    let id = existing.get(scenario.slug);
    const have = new Set(langs.filter(t => t.scenario_id === id).map(t => t.lang));
    if (id && have.size === 2) { done.skipped_scenarios.push(scenario.slug); continue; }
    // 번역이 모자란 행 = 앞선 실행이 시나리오 행만 넣고 멈춘 것(번역 insert 실패 + 정리 실패): 샘플 상태(게시+컴파일본)로 마저 채운다.
    if (id) must(await db.from('scenarios').update(scenario).eq('id', id));
    else id = (must(await db.from('scenarios').insert(scenario).select('id').single()) as { id: string }).id;
    const t = await db.from('scenario_translations').insert(translations.filter(tr => !have.has(tr.lang)).map(tr => ({ scenario_id: id, ...tr })));
    if (t.error) {
      // 번역 없는 게시 시나리오를 남기지 않는다. 정리도 실패하면 다음 실행이 위에서 마저 채운다.
      const d = await db.from('scenarios').delete().eq('id', id);
      if (d.error) throw new Error(`sample ${scenario.slug}: translations insert failed (${t.error.message}) and cleanup failed (${d.error.message}); rerun db:seed to complete it`);
      throw t.error;
    }
    done.scenarios.push(scenario.slug);
  }
  return done;
}

const Env = z.object({ SUPABASE_URL: z.url(), SUPABASE_SERVICE_KEY: z.string().min(1), ADMIN_INITIAL_PASSWORD: Password });

if (import.meta.main) main('db:seed', async () => {
  const env = readEnv(Env, process.env);
  const done = await seed(createDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY),
    { adminPassword: env.ADMIN_INITIAL_PASSWORD, samples: process.argv.includes('--with-samples') ? readSamples() : undefined });
  console.log(`db:seed ok ${JSON.stringify(done)}`);
});
