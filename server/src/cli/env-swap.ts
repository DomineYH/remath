// 전환 (H-29 5단계): 스모크를 통과한 SUPABASE_* 4개만 서버 런타임 env 파일(REMATH_ENV_FILE)에 써 넣는다.
// 다른 줄은 바이트 그대로. 같은 디렉터리의 임시 파일(600) → rename 이라 반쯤 쓴 파일은 없고, 이전 판은 <파일>.prev(600).
// 읽기·쓰기 오류는 그대로 throw → 종료코드 1 → deploy.sh 는 컨테이너를 건드리지 않는다.
// 실행: `npm run env:swap -w server` (deploy.sh 5단계, 스모크 뒤).
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { main, readEnv } from './main.ts';
import { DbUrl } from './migrate.ts';

export const KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_DB_URL', 'SUPABASE_ANON_KEY'] as const;
type Values = Record<(typeof KEYS)[number], string>;

/**
 * KEY= 로 시작하는 줄의 값만 바꾸고, 없는 키는 끝에 붙인다. 값은 따옴표·이스케이프 없이 그대로 쓴다: deploy/compose.yaml 의
 * env_file 이 format: raw(= docker run --env-file 파서)라 첫 `=` 뒤가 글자 그대로 값이 된다($VAR 치환 없음). 줄바꿈은 Env 가 막는다.
 */
export function swapEnv(text: string, v: Values) {
  const seen = new Set<string>();
  const lines = text.split('\n').map(line => {
    const k = KEYS.find(k => line.startsWith(`${k}=`));
    if (!k) return line;
    seen.add(k);
    return `${k}=${v[k]}`;
  });
  if (lines.at(-1) === '') lines.pop();
  return [...lines, ...KEYS.filter(k => !seen.has(k)).map(k => `${k}=${v[k]}`)].join('\n') + '\n';
}

export function writeEnvFile(path: string, v: Values) {
  const old = readFileSync(path, 'utf8');
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, swapEnv(old, v), { mode: 0o600, flag: 'wx', flush: true });
    writeFileSync(`${path}.prev`, old, { mode: 0o600, flush: true });
    chmodSync(`${path}.prev`, 0o600);   // 이미 있던 .prev 는 mode 옵션이 적용되지 않는다
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// docker --env-file 은 한 줄 = 한 변수: 값에 줄바꿈이 있으면 파일이 깨진다.
const OneLine = z.string().min(1).regex(/^[^\r\n]*$/, 'must be a single line');
const Env = z.object({
  REMATH_ENV_FILE: z.string().refine(isAbsolute, 'must be an absolute path'),
  SUPABASE_URL: z.url().pipe(OneLine), SUPABASE_SERVICE_KEY: OneLine, SUPABASE_DB_URL: DbUrl.pipe(OneLine), SUPABASE_ANON_KEY: OneLine,
});

if (import.meta.main) main('env:swap', async () => {
  const { REMATH_ENV_FILE, ...v } = readEnv(Env, process.env);
  writeEnvFile(REMATH_ENV_FILE, v);
  console.log(`env:swap ok ${REMATH_ENV_FILE} (${KEYS.join(', ')} replaced, previous file at .prev)`);
});
