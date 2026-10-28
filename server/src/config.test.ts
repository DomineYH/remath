import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const ROOT = new URL('../../', import.meta.url);
const disk = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'service-key', MOCK_LLM: '1' };

describe('loadConfig: startup fail-fast (B, O-6, E-21, G-28)', () => {
  it('valid env + repo files start, with the spec defaults', () => {
    const c = loadConfig(ENV, disk);
    expect(c.env).toMatchObject({ PORT: 3000, MAX_TURNS: 40, TURN_TIMEOUT_MS: 120000, COOKIE_SECURE: true });
    expect(Object.keys(c.providers)).toEqual(['openai', 'anthropic', 'gemini']);
    expect(c.templates.master.ko).toContain('{{');
  });
  it('COOKIE_SECURE=false is the only way to drop Secure', () => {
    expect(loadConfig({ ...ENV, COOKIE_SECURE: 'false' }, disk).env.COOKIE_SECURE).toBe(false);
    expect(() => loadConfig({ ...ENV, COOKIE_SECURE: 'no' }, disk)).toThrow(/COOKIE_SECURE/);
  });
  it('a missing env var fails', () => {
    const { SUPABASE_SERVICE_KEY: _, ...env } = ENV;
    expect(() => loadConfig(env, disk)).toThrow(/SUPABASE_SERVICE_KEY/);
  });
  it('MOCK_LLM other than 1 fails, unset too', () => {
    expect(() => loadConfig({ ...ENV, MOCK_LLM: '0' }, disk)).toThrow(/MOCK_LLM/);
    const { MOCK_LLM: _, ...env } = ENV;
    expect(() => loadConfig(env, disk)).toThrow(/MOCK_LLM/);
  });
  it('a broken providers.json fails', () => {
    const read = (p: string) => p.endsWith('providers.json') ? '{"openai":{}}' : disk(p);
    expect(() => loadConfig(ENV, read)).toThrow(/providers\.json/);
    expect(() => loadConfig(ENV, p => p.endsWith('providers.json') ? '{not json' : disk(p))).toThrow(/providers\.json/);
  });
  it('templates whose ko/en structure differs (checkTemplates FAIL) fail', () => {
    const read = (p: string) => p.endsWith('mentor.en.md') ? disk(p) + '\n{{EXTRA}}' : disk(p);
    expect(() => loadConfig(ENV, read)).toThrow(/mentor/);
  });
});
