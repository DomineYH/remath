// 시드 CLI (D-16, O-5, M-7, M-8): 관리자 1 + ai_settings 3 + `--with-samples`면 샘플 시나리오 5(게시+컴파일본).
// 멱등: 관리자가 있으면 건너뛰고, 있는 행은 덮어쓰거나 지우지 않는다. 데모 계정·그룹·기록은 어떤 옵션에도 없다.
// 실행: `npm run db:seed -w server [-- --with-samples]` (deploy.sh 3단계).
import { randomUUID } from 'node:crypto';
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

/** 샘플 1개 → save_scenario 입력 + 게시할 컴파일본. 목 store.ts `sample` 과 같은 compileScenario 결과. */
export function sampleRows(slug: string, json: unknown) {
  const input = ScenarioInput.parse(json);
  return { slug, input, compiled: compileScenario(input, input.translations[input.lang], input.lang, TEMPLATES) };
}

/**
 * 시드는 넣기만 한다: 지우거나 있는 행을 고치지 않는다. 샘플은 #43 의 0004 함수로 만든다 — save_scenario(행 + 번역 2행이
 * 한 트랜잭션) → 읽은 updated_at 으로 publish_scenario. 그래서 번역이 모자란 샘플은 생기지 않는다.
 */
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
  const existing = new Set((must(await db.from('scenarios').select('slug').in('slug', samples.map(r => r.slug))) as { slug: string }[]).map(r => r.slug));
  for (const { slug, input, compiled } of samples) {
    if (existing.has(slug)) { done.skipped_scenarios.push(slug); continue; }
    const id = randomUUID();
    const saved = await db.rpc('save_scenario', { p_id: id, p_slug: slug, p_input: input });
    // 그새 다른 실행이 같은 slug 를 만들었다(scenarios.slug unique): 그 행은 건드리지 않는다.
    if ((saved.error as { code?: string } | null)?.code === '23505') { done.skipped_scenarios.push(slug); continue; }
    must(saved);
    // 여기서 실패하면 샘플은 초안으로 남고, 다음 실행은 있는 slug 라 건너뛴다(스모크의 게시 수가 FAIL 로 알린다).
    const read = await db.from('scenarios').select('updated_at').eq('id', id).single();
    const pub = read.error ? read
      : await db.rpc('publish_scenario', { p_id: id, p_expected_updated_at: (read.data as { updated_at: string }).updated_at, p_compiled: compiled });
    if (pub.error || pub.data !== true)
      throw new Error(`sample ${slug} was saved as a draft but not published (${pub.error?.message ?? 'changed since it was saved'}); publish it in the admin Scenarios tab`);
    done.scenarios.push(slug);
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
