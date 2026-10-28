// 기동 검증 (B절, O-6, E-21, G-28): 하나라도 틀리면 throw → index.ts가 기동하지 않는다.
import { ProvidersFile } from '@remath/shared';
import { checkTemplates, type Templates } from '@remath/prompts';
import { z } from 'zod';

// 서버 런타임이 읽는 변수만. SUPABASE_DB_URL·ANON_KEY·ADMIN_INITIAL_PASSWORD·BACKUP_*는 각 CLI·스크립트 티켓이 검증한다.
const Env = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  MOCK_LLM: z.literal('1', { error: 'stage 2 server runs only with MOCK_LLM=1 (O-6)' }),
  MAX_TURNS: z.coerce.number().int().positive().default(40),
  TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
});
export type Config = ReturnType<typeof loadConfig>;

/** read(path) = 저장소 루트 기준 상대 경로의 파일 내용. */
export function loadConfig(env: Record<string, string | undefined>, read: (path: string) => string) {
  const e = Env.safeParse(env);
  if (!e.success) throw new Error('invalid environment:\n' + z.prettifyError(e.error));

  let providers;
  try { providers = ProvidersFile.parse(JSON.parse(read('shared/providers.json'))); }
  catch (err) { throw new Error(`shared/providers.json is invalid: ${err instanceof Error ? err.message : err}`); }

  const file = (name: string, lang: string) => read(`prompts/templates/${name}.${lang}.md`);
  const templates = Object.fromEntries((['master', 'analysis', 'mentor'] as const)
    .map(n => [n, { ko: file(n, 'ko'), en: file(n, 'en') }])) as Templates;
  const bad = checkTemplates(templates).filter(t => !t.ok).map(t => t.name);
  if (bad.length) throw new Error(`prompts/templates ko/en structure differs (checkTemplates FAIL): ${bad.join(', ')}`);

  return { env: e.data, providers, templates };
}
