// deploy.sh 5단계의 env 파일 교체: SUPABASE_* 4개만 바뀌고, 오류면 아무것도 바꾸지 않는다.
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { swapEnv, writeEnvFile } from './env-swap.ts';

/**
 * docker/cli pkg/kvfile 규칙(= Compose env_file `format: raw`, `docker run --env-file`): 앞 공백을 지운 줄이 비었거나 `#` 로
 * 시작하면 무시, 첫 `=` 에서 나눠 키는 앞 공백만 지우고(공백이 남으면 오류), 값은 글자 그대로. `=` 없는 줄은 호스트 env 를 읽는다.
 */
function parseRaw(text: string, host: Record<string, string> = {}) {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').replace(/^[ \t]+/, '');
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('='), key = i < 0 ? line : line.slice(0, i);
    if (/\s/.test(key)) throw new Error(`variable '${key}' contains whitespaces`);
    if (i >= 0) out[key] = line.slice(i + 1);
    else if (key in host) out[key] = host[key];
  }
  return out;
}

const NEW = { SUPABASE_URL: 'https://new.supabase.co', SUPABASE_SERVICE_KEY: 'new-service', SUPABASE_DB_URL: 'postgres://u:p@new:5432/postgres', SUPABASE_ANON_KEY: 'new-anon' };
const OLD = '# runtime env\nMOCK_LLM=1\nSUPABASE_URL=https://old.supabase.co\nCOOKIE_SECURE=false\nSUPABASE_SERVICE_KEY=old-service\nSUPABASE_URL_EXTRA=keep\n';
const dir = () => mkdtempSync(join(tmpdir(), 'env-swap-'));

describe('env:swap (H-29 5)', () => {
  it('replaces only the four SUPABASE_* keys in place and appends the missing ones', () => {
    expect(swapEnv(OLD, NEW)).toBe('# runtime env\nMOCK_LLM=1\nSUPABASE_URL=https://new.supabase.co\nCOOKIE_SECURE=false\nSUPABASE_SERVICE_KEY=new-service\n'
      + 'SUPABASE_URL_EXTRA=keep\nSUPABASE_DB_URL=postgres://u:p@new:5432/postgres\nSUPABASE_ANON_KEY=new-anon\n');
    expect(swapEnv(swapEnv(OLD, NEW), NEW)).toBe(swapEnv(OLD, NEW));   // 다시 돌려도 같다
  });

  it('values with $VAR, ${VAR} and quotes reach the container byte for byte (env_file format: raw)', () => {
    const tricky = { ...NEW, SUPABASE_DB_URL: 'postgres://user:literal$UNSET_REVIEW41@db:5432/postgres', SUPABASE_SERVICE_KEY: "k${X}'\"`$(id)` #x" };
    const d = dir(), f = join(d, 'server.env');
    writeFileSync(f, OLD);
    writeEnvFile(f, tricky);
    const text = readFileSync(f, 'utf8');
    expect(text).toContain('\nSUPABASE_DB_URL=postgres://user:literal$UNSET_REVIEW41@db:5432/postgres\n');
    expect(text).toContain("\nSUPABASE_SERVICE_KEY=k${X}'\"`$(id)` #x\n");
    // 호스트에 X·UNSET_REVIEW41 가 있어도 raw 는 치환하지 않는다
    const env = parseRaw(text, { X: 'host', UNSET_REVIEW41: 'host' });
    for (const k of Object.keys(tricky) as (keyof typeof tricky)[]) expect(env[k]).toBe(tricky[k]);
    expect(env).toMatchObject({ MOCK_LLM: '1', COOKIE_SECURE: 'false', SUPABASE_URL_EXTRA: 'keep' });
  });

  it('writes the file with mode 600 and keeps the previous one as .prev (600)', () => {
    const d = dir(), f = join(d, 'server.env');
    writeFileSync(f, OLD, { mode: 0o644 });
    writeFileSync(`${f}.prev`, 'stale', { mode: 0o644 });
    writeEnvFile(f, NEW);
    expect(readFileSync(f, 'utf8')).toBe(swapEnv(OLD, NEW));
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readFileSync(`${f}.prev`, 'utf8')).toBe(OLD);
    expect(statSync(`${f}.prev`).mode & 0o777).toBe(0o600);
    expect(readdirSync(d).sort()).toEqual(['server.env', 'server.env.prev']);   // 임시 파일 없음
  });

  it('a read error aborts before anything is written', () => {
    const d = dir();
    expect(() => writeEnvFile(join(d, 'missing.env'), NEW)).toThrow(/ENOENT/);
    expect(() => writeEnvFile(d, NEW)).toThrow(/EISDIR/);
    expect(readdirSync(d)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('a write error leaves the original file untouched and no temp file behind', () => {
    const d = dir(), f = join(d, 'server.env');
    writeFileSync(f, OLD, { mode: 0o600 });
    chmodSync(d, 0o500);   // 디렉터리에 쓸 수 없음
    try {
      expect(() => writeEnvFile(f, NEW)).toThrow(/EACCES/);
    } finally { chmodSync(d, 0o700); }
    expect(readFileSync(f, 'utf8')).toBe(OLD);
    expect(existsSync(`${f}.prev`)).toBe(false);
    expect(readdirSync(d)).toEqual(['server.env']);
  });
});
