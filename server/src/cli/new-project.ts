// 새 Supabase 프로젝트 (H-29 1단계, O-4): Management API 로 생성 → ACTIVE_HEALTHY 까지 폴링 → 레거시 JWT anon·service_role 키 +
// session pooler 연결 문자열 → <out> 에 SUPABASE_* 4줄(600). 실행: `npm run db:new-project -w server -- <out>` (deploy.sh --new, #49 restore.sh).
// 토큰은 Authorization 헤더로만 나간다: 출력·파일·오류 메시지에 남기지 않는다. 생성 말고는 어떤 프로젝트도 바꾸거나 지우지 않는다(GET 만).
// 생성 뒤 실패하면 ref 를 알리고 프로젝트는 남겨 둔다(사람이 삭제).
// 문서: https://api.supabase.com/api/v1-json (v1-create-a-project, v1-get-project, v1-get-project-api-keys, v1-get-pooler-config)
import { chmodSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { KEYS } from './env-swap.ts';
import { main, readEnv } from './main.ts';

type Values = Record<(typeof KEYS)[number], string>;
interface Opts {
  token: string; org: string; region: string; dbPass: string; name: string; fault?: 'anon_as_service';
  fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<unknown>; timeoutMs: number; intervalMs: number; log?: (s: string) => void;
}

const API = 'https://api.supabase.com';
const LEFT = 'left in place, delete it by hand in the Supabase dashboard if you do not need it';
class HttpError extends Error {
  status: number; retryAfterMs: number;
  constructor(msg: string, status: number, retryAfterMs: number) { super(msg); this.status = status; this.retryAfterMs = retryAfterMs; }
}
// encodeURIComponent 는 !'()* 를 남긴다: 셸·env 파일에서도 안전하도록 RFC 3986 unreserved 말고는 모두 인코딩
const encode = (s: string) => Array.from(new TextEncoder().encode(s), b => /[\w.~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');

export async function newProject(o: Opts): Promise<Values> {
  const f = o.fetch ?? fetch, now = o.now ?? Date.now, sleep = o.sleep ?? setTimeout, log = o.log ?? console.log;
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await f(`${API}${path}`, { method, headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.ok) return r.json();
    const text = (await r.text().catch(() => '')).replaceAll(o.token, '***').slice(0, 200);
    throw new HttpError(`${method} ${path.replace(/\?.*/, '')}: HTTP ${r.status} ${text}`, r.status, Number(r.headers.get('retry-after')) * 1000 || 0);
  };
  const deadline = now() + o.timeoutMs;
  /** get 이 값을 줄 때까지(undefined = 아직) interval 마다. 429·5xx·네트워크 오류는 재시도, 다른 4xx 는 곧바로 실패. */
  const until = async <T>(what: string, get: () => Promise<T | undefined>): Promise<T> => {
    for (;;) {
      let wait = o.intervalMs;
      try {
        const v = await get();
        if (v !== undefined) return v;
      } catch (err) {
        if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err;
        if (err instanceof HttpError) wait = Math.max(err.retryAfterMs, wait);
        if (!(err instanceof HttpError) && !(err instanceof TypeError)) throw err;   // fetch 네트워크 오류 = TypeError
      }
      if (now() + wait > deadline) throw new Error(`${what} within ${o.timeoutMs / 1000}s`);
      await sleep(wait);
    }
  };

  // 생성은 재시도하지 않는다(과금): 429 만 예외 — 거절된 요청이라 만들어진 것이 없다.
  const body = { name: o.name, organization_slug: o.org, db_pass: o.dbPass, region_selection: { type: 'specific', code: o.region } };
  let created: { ref: string };
  for (;;) {
    try { created = await api('POST', '/v1/projects', body); break; } catch (err) {
      if (!(err instanceof HttpError && err.status === 429)) throw err;
      const wait = err.retryAfterMs || o.intervalMs;
      if (now() + wait > deadline) throw new Error(`${err.message}: still rate limited within ${o.timeoutMs / 1000}s; no project was created`);
      await sleep(wait);
    }
  }
  const ref = created.ref;
  log(`new-project: created ${ref} (${o.name}, ${o.region}); waiting for ACTIVE_HEALTHY`);
  try {
    await until('not ACTIVE_HEALTHY', async () => {
      const p = await api('GET', `/v1/projects/${ref}`) as { status: string };
      if (p.status === 'INIT_FAILED' || p.status === 'REMOVED') throw new Error(`status ${p.status}`);
      return p.status === 'ACTIVE_HEALTHY' || undefined;
    });
    // 서버·스모크는 레거시 JWT 키(anon·service_role)를 쓴다. 새 sb_ 키(publishable·secret)는 쓰지 않는다.
    const keys = await until('no api keys', async () => api('GET', `/v1/projects/${ref}/api-keys?reveal=true`) as Promise<{ name: string; type?: string | null; api_key?: string | null }[]>);
    const key = (name: string) => keys.find(k => k.name === name && (k.type ?? 'legacy') === 'legacy')?.api_key;
    const anon = key('anon'), service = key('service_role');
    if (!anon || !service) throw new Error('legacy anon/service_role keys are missing (disabled on this project?)');
    // 직접 호스트 db.<ref>.supabase.co 는 IPv6 전용이라 session pooler(5432). pooler 는 ACTIVE_HEALTHY 뒤에 늦게 뜰 수 있다.
    const pool = await until('no PRIMARY pooler config', async () => {
      const list = await api('GET', `/v1/projects/${ref}/config/database/pooler`) as { database_type: string; db_user: string; db_host: string; db_name: string }[];
      return list.find(p => p.database_type === 'PRIMARY');
    });
    if (o.fault === 'anon_as_service') log('new-project: WARNING DEPLOY_NEW_FAULT=anon_as_service: SUPABASE_ANON_KEY is the SERVICE key; the smoke must FAIL (G3 8)');
    log(`new-project: ${ref} ACTIVE_HEALTHY, keys and pooler ${pool.db_host} received`);
    return {
      SUPABASE_URL: `https://${ref}.supabase.co`, SUPABASE_SERVICE_KEY: service,
      SUPABASE_DB_URL: `postgresql://${encode(pool.db_user)}:${encode(o.dbPass)}@${pool.db_host}:5432/${pool.db_name}?sslmode=require`,
      SUPABASE_ANON_KEY: o.fault === 'anon_as_service' ? service : anon,
    };
  } catch (err) {
    throw new Error(`project ${ref}: ${(err as Error).message}; ${LEFT}`);
  }
}

/** deploy.sh 가 mktemp 로 만든 파일에 쓴다. 이미 있는 파일은 writeFileSync 의 mode 가 적용되지 않아 chmod. */
export function writeNewEnv(path: string, v: Values) {
  writeFileSync(path, KEYS.map(k => `${k}=${v[k]}\n`).join(''), { mode: 0o600 });
  chmodSync(path, 0o600);
}

const Env = z.object({
  SUPABASE_ACCESS_TOKEN: z.string().min(1), SUPABASE_ORG_ID: z.string().regex(/^[\w-]+$/, 'must be the organization slug'),
  SUPABASE_REGION: z.string().min(1), SUPABASE_DB_PASSWORD: z.string().min(1),
  NEW_PROJECT_TIMEOUT_S: z.coerce.number().int().positive().default(600),
  DEPLOY_NEW_FAULT: z.enum(['anon_as_service']).optional(),
});

if (import.meta.main) main('db:new-project', async () => {
  const out = process.argv[2];
  if (!out) throw new Error('usage: npm run db:new-project -w server -- <out-env-file>');
  const env = readEnv(Env, process.env);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  writeNewEnv(out, await newProject({
    token: env.SUPABASE_ACCESS_TOKEN, org: env.SUPABASE_ORG_ID, region: env.SUPABASE_REGION, dbPass: env.SUPABASE_DB_PASSWORD,
    name: `remath-${stamp}`, fault: env.DEPLOY_NEW_FAULT, timeoutMs: env.NEW_PROJECT_TIMEOUT_S * 1000, intervalMs: 10_000,
  }));
  console.log(`db:new-project ok (${KEYS.join(', ')} written to ${out})`);
});
