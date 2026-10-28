// deploy.sh 5단계의 env 파일 교체: SUPABASE_* 4개만 바뀌고, 오류면 아무것도 바꾸지 않는다.
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { swapEnv, writeEnvFile } from './env-swap.ts';

const NEW = { SUPABASE_URL: 'https://new.supabase.co', SUPABASE_SERVICE_KEY: 'new-service', SUPABASE_DB_URL: 'postgres://u:p@new:5432/postgres', SUPABASE_ANON_KEY: 'new-anon' };
const OLD = '# runtime env\nMOCK_LLM=1\nSUPABASE_URL=https://old.supabase.co\nCOOKIE_SECURE=false\nSUPABASE_SERVICE_KEY=old-service\nSUPABASE_URL_EXTRA=keep\n';
const dir = () => mkdtempSync(join(tmpdir(), 'env-swap-'));

describe('env:swap (H-29 5)', () => {
  it('replaces only the four SUPABASE_* keys in place and appends the missing ones', () => {
    expect(swapEnv(OLD, NEW)).toBe('# runtime env\nMOCK_LLM=1\nSUPABASE_URL=https://new.supabase.co\nCOOKIE_SECURE=false\nSUPABASE_SERVICE_KEY=new-service\n'
      + 'SUPABASE_URL_EXTRA=keep\nSUPABASE_DB_URL=postgres://u:p@new:5432/postgres\nSUPABASE_ANON_KEY=new-anon\n');
    expect(swapEnv(swapEnv(OLD, NEW), NEW)).toBe(swapEnv(OLD, NEW));   // 다시 돌려도 같다
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
