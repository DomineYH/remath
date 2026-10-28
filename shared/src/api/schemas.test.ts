// Contract checks (prototype api-contract/check.ts 2–5) plus the ticket 14·15·18·19·20 additions.
import { describe, expect, it } from 'vitest';
import { ERROR_STATUS, ErrorCode } from './errors.ts';
import { routes } from './routes.ts';
import * as S from './schemas.ts';

const now = '2026-10-28T00:00:00.000Z';
const uuid = '00000000-0000-4000-8000-000000000001';

describe('nickname and password rules (PRD 9)', () => {
  const nickOk = ['하늘쌤', 'ab', 'a_b.c-1', '123456'];
  const nickBad = ['a', 'a@b', 'a@b.c', '1234567', '12345678', 'x'.repeat(17), 'has space'];
  const pwOk = ['abcd1234', 'Pa55word!', 'a1b2c3d4e5'];
  const pwBad = ['abcdefgh', '12345678', 'abc 1234', 'ab12', ''];

  it('accepts and rejects nicknames', () => {
    for (const n of nickOk) expect(S.Nickname.safeParse(n).success, n).toBe(true);
    for (const n of nickBad) expect(S.Nickname.safeParse(n).success, n).toBe(false);
  });
  it('accepts and rejects passwords', () => {
    for (const p of pwOk) expect(S.Password.safeParse(p).success, p).toBe(true);
    for (const p of pwBad) expect(S.Password.safeParse(p).success, p).toBe(false);
  });
  it('passwordChecks agrees with Password on every sample', () => {
    for (const p of [...pwOk, ...pwBad, 'abcd 123', 'ABCDEFG1', '1a']) {
      expect(S.passwordChecks(p).every(Boolean), p).toBe(S.Password.safeParse(p).success);
    }
  });
});

describe('SSE events', () => {
  const turn = { seq: 2, speaker: 'teacher', text: '왜 그렇게 생각했어?', leverage: 'Eliciting', object: null, trigger: null, created_at: now };
  const report = { total: 5, reached: true, verdict: 'clean', rows: [{ name: 'Eliciting', desc: '', count: 5, turns: [{ seq: 2, text: '…' }] }], summary: null };
  const samples = [
    { type: 'classification', leverage: 'Eliciting', object: null },
    { type: 'student', text: '음…', final: false },
    { type: 'trigger', trigger: 2 },
    { type: 'mentor', text: '이렇게 물어보세요', final: true },
    { type: 'done', ended: false, turns: [turn] },
    { type: 'done', ended: true, report },
    { type: 'done', ended: true, report: null },
    { type: 'error', code: 'provider_unavailable', message: 'upstream 503', retryable: true },
  ];
  const state = { type: 'state', mis: [1, 0], counts: {}, goal_reached: false, last_trigger: null };

  it('teacher union accepts the samples and rejects malformed done', () => {
    for (const ev of samples) expect(S.SseEvent.safeParse(ev).success, JSON.stringify(ev)).toBe(true);
    expect(S.SseEvent.safeParse({ type: 'done', ended: true, turns: [] }).success).toBe(false);
  });
  it('state event is admin-only (ticket 15)', () => {
    expect(S.SseEvent.safeParse(state).success).toBe(false);
    expect(S.AdminSseEvent.safeParse(state).success).toBe(true);
    for (const ev of samples) expect(S.AdminSseEvent.safeParse(ev).success).toBe(true);
    expect(S.AdminSseEvent.safeParse({ ...state, mis: [3] }).success).toBe(false);
  });
  it('SessionDetail requires turn_limit, AdminSessionDetail requires state', () => {
    const row = { id: uuid, scenario_id: uuid, scenario_name: 'Gabriel', lang: 'en', user_id: uuid, nickname: 'tester1', started_at: now, ended_at: null, goal_reached: false, turn_count: 0 };
    const detail = { session: row, turns: [], report: null, turn_limit: 40 };
    expect(S.SessionDetail.safeParse(detail).success).toBe(true);
    expect(S.SessionDetail.safeParse({ ...detail, turn_limit: undefined }).success).toBe(false);
    expect(S.AdminSessionDetail.safeParse(detail).success).toBe(false);
    const { type: _, ...st } = state;
    expect(S.AdminSessionDetail.safeParse({ ...detail, state: st }).success).toBe(true);
    expect('summary' in S.SessionRow.shape).toBe(false);
    expect('summary' in S.SessionDetail.shape).toBe(false);
  });
});

describe('ScenarioInput misconception alignment', () => {
  const tr = (n: number) => ({ misconceptions: Array.from({ length: n }, () => ({ kw: 'k', h: 'h', c: 'c' })) });
  const input = (n: number) => ({ lang: 'ko', student_prefix: '🦊', mentor_prefix: '🦉', grade: '5', internal: { misconceptions: [{ text: 'm1' }] }, classification: { leverage: [], object: [] }, translations: { ko: tr(n), en: tr(n) } });
  it('refines', () => {
    expect(S.ScenarioInput.safeParse(input(1)).success).toBe(true);
    expect(S.ScenarioInput.safeParse(input(2)).success).toBe(false);
  });
});

describe('audit log (ticket 20)', () => {
  const entry = { id: uuid, actor_id: null, action: 'auth.login_failed', target: 'tester1', meta: { realm: 'teacher' }, created_at: now };
  it('AuditAction is the ticket-20 list verbatim', () => {
    expect(S.AuditAction.options).toEqual([
      'scenario.create', 'scenario.update', 'scenario.publish', 'scenario.delete',
      'group.create', 'group.update', 'group.delete',
      'user.create', 'user.password_reset', 'user.delete',
      'ai.update', 'admin.password_reset', 'auth.login_failed', 'auth.password_change',
    ]);
  });
  it('AuditEntry has no updated_at', () => {
    expect(S.AuditEntry.safeParse(entry).success).toBe(true);
    expect(S.AuditEntry.safeParse({ ...entry, updated_at: now }).success).toBe(false);
    expect(S.AuditEntry.safeParse({ ...entry, action: 'auth.login' }).success).toBe(false);
  });
});

describe('providers.json (ticket 18)', () => {
  const file = {
    openai: { name: 'OpenAI', param: 'reasoning.effort', efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      models: [
        { id: 'gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], recommended: true },
        { id: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium' },
        { id: 'gpt-6-sol', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium' },
        { id: 'gpt-6-luna', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium' },
        { id: 'gpt-5.6-terra', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium' },
        { id: 'gpt-5.6-luna', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium' },
        { id: 'gpt-5.5', efforts: ['none', 'low', 'medium', 'high', 'xhigh'], default_effort: 'medium' }] },
    anthropic: { name: 'Anthropic', param: 'output_config.effort', efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      models: [
        { id: 'claude-fable-5-1', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'high', recommended: true },
        { id: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium' },
        { id: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'high' },
        { id: 'claude-haiku-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium' }] },
    gemini: { name: 'Google Gemini', param: 'generation_config.thinking_level', efforts: ['minimal', 'low', 'medium', 'high'],
      models: [
        { id: 'gemini-4-argon', efforts: ['low', 'medium', 'high'], default_effort: 'medium', recommended: true },
        { id: 'gemini-3.8-flash', efforts: ['low', 'medium', 'high'], default_effort: 'medium' },
        { id: 'gemini-3.6-flash', efforts: ['minimal', 'low', 'medium', 'high'], default_effort: 'medium' },
        { id: 'gemini-3.5-flash-lite', efforts: ['minimal', 'low', 'medium', 'high'], default_effort: 'minimal' }] },
  };
  it('parses the ticket-18 file', () => expect(S.ProvidersFile.safeParse(file).success).toBe(true));
  it('rejects default_effort outside efforts, a model effort outside the provider set, two recommended', () => {
    const bad = structuredClone(file); bad.openai.models[1].default_effort = 'none';
    expect(S.ProvidersFile.safeParse(bad).success).toBe(false);
    const bad2 = structuredClone(file); bad2.gemini.models[0].efforts.push('max');
    expect(S.ProvidersFile.safeParse(bad2).success).toBe(false);
    const bad3 = structuredClone(file); bad3.anthropic.models[1].recommended = true;
    expect(S.ProvidersFile.safeParse(bad3).success).toBe(false);
    const { gemini: _, ...two } = file;
    expect(S.ProvidersFile.safeParse(two).success).toBe(false);
  });
});

describe('error codes', () => {
  it('every ErrorCode has an HTTP status', () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ErrorCode.options].sort());
    expect(ERROR_STATUS.invalid_credentials).toBe(401);
    expect(ERROR_STATUS.nickname_taken).toBe(409);
    expect(ERROR_STATUS.validation_failed).toBe(400);
  });
  it('route error lists use known codes', () => {
    for (const r of routes) for (const e of r.errors) expect(ErrorCode.options, `${r.method} ${r.path}`).toContain(e);
  });
});

describe('route table', () => {
  it('has 38 unique rows under /api/', () => {
    expect(routes).toHaveLength(38);
    const keys = routes.map(r => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(38);
    for (const r of routes) expect(r.path.startsWith('/api/')).toBe(true);
  });
  it('/api/admin/* is admin-only except the admin login', () => {
    for (const r of routes.filter(r => r.path.startsWith('/api/admin/'))) {
      expect(r.realm === 'admin' || r.path === '/api/admin/auth/login', `${r.method} ${r.path}`).toBe(true);
    }
  });
  it('has the providers row and the admin session detail (tickets 15, 18)', () => {
    const find = (m: string, p: string) => routes.find(r => r.method === m && r.path === p);
    expect(find('GET', '/api/admin/ai/providers')).toMatchObject({ realm: 'admin', response: S.ProvidersFile, errors: [] });
    expect(find('GET', '/api/admin/sessions/:id')?.response).toBe(S.AdminSessionDetail);
    expect(find('POST', '/api/sessions/:id/turns')?.errors).toContain('turn_limit_reached');
  });
});
