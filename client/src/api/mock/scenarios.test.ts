// A-4 (part): the five samples load published with compiled prompts, getScenarioPrompt = compileScenario. A-10 (part): getProviders.
import * as S from '@remath/shared';
import { compileScenario, TEMPLATES } from '@remath/prompts';
import seoyeon from '@remath/seed/scenarios/seoyeon.json';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../types.ts';
import { createMockApi } from './index.ts';
import { memoryStorage, seedDb, Store } from './store.ts';

const T0 = '2026-10-28T00:00:00.000Z';
async function admin() {
  const store = new Store(memoryStorage(), () => seedDb(T0));
  const api = createMockApi({ realm: 'admin', store, now: () => T0, adminPassword: 'Admin1234' });
  await api.adminLogin({ nickname: 'admin', password: 'Admin1234' });
  return api;
}

describe('sample scenarios (H-38, G-33)', () => {
  it('list cards: names, language, misconception and classification counts, no groups', async () => {
    const list = await (await admin()).listScenarios();
    for (const s of list) expect(S.ScenarioSummary.strict().parse(s)).toEqual(s);
    expect(list.map(s => [s.name, s.lang, s.misconception_count, s.classification_count.leverage, s.classification_count.object, s.groups.length, s.session_count]))
      .toEqual([['가브리엘', 'ko', 3, 4, 9, 0, 0], ['Noah', 'en', 4, 4, 9, 0, 0], ['지우', 'ko', 3, 4, 9, 0, 0], ['하준', 'ko', 3, 0, 0, 0, 0], ['서연', 'ko', 3, 4, 9, 0, 0]]);
  });
  it('getScenario returns the stored ScenarioInput with both editions', async () => {
    const api = await admin(), id = (await api.listScenarios()).find(s => s.slug === 'seoyeon')!.id;
    const s = await api.getScenario(id);
    expect(S.ScenarioAdmin.parse(s)).toBeTruthy();
    expect(S.ScenarioInput.parse(s)).toEqual(S.ScenarioInput.parse(seoyeon));
    expect(s).not.toHaveProperty('compiled_prompt');
  });
  it('getScenarioPrompt = compileScenario of the active language edition', async () => {
    const api = await admin(), list = await api.listScenarios();
    for (const { id } of list) {
      const s = await api.getScenario(id);
      expect(await api.getScenarioPrompt(id)).toEqual(compileScenario(s, s.translations[s.lang], s.lang, TEMPLATES));
    }
    const hajun = list.find(s => s.slug === 'hajun')!;
    expect((await api.getScenarioPrompt(hajun.id)).analysis).toBeNull();
  });
  it('unknown id → 404; teacher realm → 401', async () => {
    const api = await admin();
    await expect(api.getScenarioPrompt('00000000-0000-4000-8000-0000000000ff')).rejects.toSatisfy(e => e instanceof ApiError && e.status === 404);
    const teacher = createMockApi({ realm: 'teacher', store: new Store(memoryStorage(), () => seedDb(T0)), now: () => T0 });
    await expect(teacher.getProviders()).rejects.toSatisfy(e => e instanceof ApiError && e.status === 401);
  });
});

describe('providers (A-10 part, D-20)', () => {
  it('getProviders passes ProvidersFile with ticket 18 contents', async () => {
    const p = S.ProvidersFile.parse(await (await admin()).getProviders());
    expect([p.openai.models.length, p.anthropic.models.length, p.gemini.models.length]).toEqual([7, 4, 4]);
    expect(p.gemini.models.map(m => m.id)).not.toContain('gemini-3.8-pro');
    expect(p.openai.models.flatMap(m => m.efforts)).not.toContain('minimal');
    expect(p.openai.models.find(m => m.id === 'gpt-5.5')!.efforts).not.toContain('max');
  });
});
