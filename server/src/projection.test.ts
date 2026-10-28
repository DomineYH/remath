// 투영 (E-19, M-10): Data API 조인 결과 → 목 projection.ts 와 같은 응답 모양.
import * as S from '@remath/shared';
import { describe, expect, it } from 'vitest';
import { toAdmin, toSummary, userRow, type ScenarioDbRow } from './projection.ts';

const G1 = '11111111-1111-4111-8111-111111111111', G2 = '22222222-2222-4222-8222-222222222222';
const SA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', SB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T = '2026-10-28T00:00:00.000Z';
const tr = (lang: 'ko' | 'en', name: string) => ({
  lang, name, description: '', problem: `${name} problem`, chars: '', greet: '', aha: '', t1: '', t2: '', t3: '',
  confused: [], elicit: [], misconceptions: [{ kw: 'x', h: 'h', c: 'c' }],
});
const row: ScenarioDbRow = {
  id: SA, slug: 'scenario-aaaaaaaa', status: 'published', lang: 'ko', student_prefix: '🙂', mentor_prefix: '', grade: '3',
  internal: S.Internal.parse({ misconceptions: [{ text: 'm' }] }), classification: { leverage: [{ name: 'L', desc: '', ex: '' }], object: [] },
  compiled_prompt: { student: 'secret', analysis: null, mentor: 'secret' }, created_at: T, updated_at: T,
  scenario_translations: [tr('en', 'Noah'), tr('ko', '노아')],
  group_scenarios: [{ groups: { id: G1, name: 'A반' } }],
  sessions: [{ count: 3 }],
};

describe('scenario projection', () => {
  it('ScenarioAdmin has no compiled_prompt, inlines ko/en translations and joins groups and session_count', () => {
    const a = toAdmin(row);
    expect(Object.keys(a).sort()).toEqual(['classification', 'created_at', 'grade', 'groups', 'id', 'internal', 'lang', 'mentor_prefix',
      'session_count', 'slug', 'status', 'student_prefix', 'translations', 'updated_at']);
    expect(a.translations.ko.name).toBe('노아');
    expect(a.translations.en).not.toHaveProperty('lang');
    expect(a.groups).toEqual([{ id: G1, name: 'A반' }]);
    expect(a.session_count).toBe(3);
    expect(S.ScenarioAdmin.strict().parse(a)).toEqual(a);
  });

  it('ScenarioSummary uses the active lang texts and counts', () => {
    expect(toSummary(row)).toMatchObject({ name: '노아', problem: '노아 problem', misconception_count: 1,
      classification_count: { leverage: 1, object: 0 }, session_count: 3 });
  });
});

describe('user projection', () => {
  it('scenario_count counts distinct scenarios across the groups a teacher belongs to', () => {
    const u = userRow({
      id: SA, nickname: 'kim', created_at: T, pw_updated_at: T, sessions: [{ count: 2 }],
      group_members: [
        { groups: { id: G1, name: 'A', group_scenarios: [{ scenario_id: SA }, { scenario_id: SB }] } },
        { groups: { id: G2, name: 'B', group_scenarios: [{ scenario_id: SB }] } },
      ],
    });
    expect(u).toEqual({ id: SA, nickname: 'kim', groups: [{ id: G1, name: 'A' }, { id: G2, name: 'B' }], scenario_count: 2,
      session_count: 2, created_at: T, pw_updated_at: T });
  });
});
