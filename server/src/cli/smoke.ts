// 배포 스모크 (H-29 4단계, D-17, ADR-0003): service key 로 행 수, anon 키로 거부. 하나라도 FAIL 이면 종료코드 1.
// 실행: `npm run db:smoke -w server [-- --with-samples]` (deploy.sh 4단계).
import { z } from 'zod';
import { main, readEnv } from './main.ts';
import { readSamples } from './seed.ts';

export interface Check { name: string; ok: boolean; detail: string }
interface Opts { url: string; serviceKey: string; anonKey: string; samples?: string[]; fetch?: typeof fetch }

export async function smoke(o: Opts): Promise<Check[]> {
  const f = o.fetch ?? fetch;
  const get = (path: string, key: string) => f(`${o.url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  const rows = async (path: string): Promise<{ id: string }[]> => {
    const r = await get(path, o.serviceKey);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const checks: Check[] = [];
  const count = async (name: string, path: string, want: number) => {
    try {
      const got = await rows(path);
      checks.push({ name, ok: got.length === want, detail: `${got.length} rows, want ${want}` });
      return got;
    } catch (err) { checks.push({ name, ok: false, detail: (err as Error).message }); return []; }
  };

  await count('admin user', 'users?select=id&role=eq.admin', 1);
  await count('ai_settings', 'ai_settings?select=role', 3);
  if (o.samples) {
    // 샘플 slug 로 센다: 관리자가 만든 시나리오가 있어도 재배포 스모크가 깨지지 않게.
    const s = await count('sample scenarios published', `scenarios?select=id&status=eq.published&slug=in.(${o.samples.join(',')})`, o.samples.length);
    await count('sample translations', `scenario_translations?select=id&scenario_id=in.(${s.map(r => r.id).join(',')})`, o.samples.length * 2);
  }
  // 401/403 만으로는 틀린 키(게이트웨이 "Invalid API key")도 통과한다: DB 권한 거부(42501)여야 통과.
  try {
    const r = await get('scenarios?select=internal', o.anonKey);
    const body = await r.json().catch(() => null) as { code?: string } | null;
    checks.push({ name: 'anon denied scenarios.internal', ok: (r.status === 401 || r.status === 403) && body?.code === '42501', detail: `HTTP ${r.status} code ${body?.code ?? '-'}` });
  } catch (err) { checks.push({ name: 'anon denied scenarios.internal', ok: false, detail: (err as Error).message }); }
  return checks;
}

const Env = z.object({ SUPABASE_URL: z.url(), SUPABASE_SERVICE_KEY: z.string().min(1), SUPABASE_ANON_KEY: z.string().min(1) });

if (import.meta.main) main('db:smoke', async () => {
  const env = readEnv(Env, process.env);
  const checks = await smoke({ url: env.SUPABASE_URL.replace(/\/$/, ''), serviceKey: env.SUPABASE_SERVICE_KEY, anonKey: env.SUPABASE_ANON_KEY,
    samples: process.argv.includes('--with-samples') ? Object.keys(readSamples()) : undefined });
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  if (checks.some(c => !c.ok)) throw new Error('smoke FAIL');
});
