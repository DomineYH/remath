// Vercel 진입점의 번들 맵(V5): loadConfig 가 읽는 경로가 모두 번들에 있고, 디스크와 같은 텍스트다.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { bundledRead } from './vercel.ts';

const ROOT = new URL('../../', import.meta.url);
const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'service-key', MOCK_LLM: '1' };

describe('bundledRead: loadConfig reads bundled text, not disk (V5)', () => {
  it('every path loadConfig reads resolves to the repo file text, and the config passes', () => {
    const read = bundledRead(), paths: string[] = [];
    const c = loadConfig(ENV, p => { paths.push(p); return read(p); });
    expect(paths).toContain('shared/providers.json');
    expect(paths.filter(p => p.startsWith('prompts/templates/'))).toHaveLength(6);
    for (const p of paths) expect(read(p)).toBe(readFileSync(new URL(p, ROOT), 'utf8'));
    expect(Object.keys(c.providers)).toEqual(['openai', 'anthropic', 'gemini']);
  });
  it('a path outside the bundle fails loudly', () => {
    expect(() => bundledRead()('prompts/templates/nope.ko.md')).toThrow(/not bundled/);
  });
});
