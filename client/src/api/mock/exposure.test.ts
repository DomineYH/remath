// A-1: every response and turn event the teacher realm can reach, walked deep at runtime: no internal keys,
// and scenario rows are exactly the public scenario view (+ group_ids). The schema-level twin is contract.test (C-2).
import * as S from '@remath/shared';
import { describe, expect, it } from 'vitest';
import { createMockApi } from './index.ts';
import { memoryStorage, seedDb, Store } from './store.ts';

const T0 = '2026-10-28T00:00:00.000Z';
const ADMIN_PW = 'Admin1234';
const FORBIDDEN = ['internal', 'compiled_prompt', 'progress', 'counts', 'summary', 'password', 'password_hash', 'state'];
const L1 = ['안녕, 네 이름이 뭐야?', '어떻게 풀었는지 말해 줄래?', '한 친구가 받는 걸 모두 합치면 얼마야?', '그러면 한 사람이 받는 게 전부 얼마인지 하나로 말해 볼래?', '4분의 1 조각을 반으로 자르면 어떻게 될까?', '그 조각을 더 작게 자르면 8분의 1이 몇 개야?', '8분의 1 조각이 다 해서 몇 개야?', '모두 몇 조각인지 세어 볼래?'];

/** Paths of forbidden keys anywhere in `v`. A SessionReport's own `summary` is the analysis sentence (D-17): the report must parse strictly, then that one key is allowed. */
function leaks(v: unknown, path = '$'): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => leaks(x, `${path}[${i}]`));
  if (!v || typeof v !== 'object') return [];
  const isReport = 'verdict' in v && 'rows' in v;
  if (isReport) S.SessionReport.strict().parse(v);
  return Object.entries(v).flatMap(([k, x]) => [...(FORBIDDEN.includes(k) && !(isReport && k === 'summary') ? [`${path}.${k}`] : []), ...leaks(x, `${path}.${k}`)]);
}

describe('A-1 teacher exposure', () => {
  it('walker sanity: finds nested keys, allows only a report summary', () => {
    expect(leaks([{ a: { internal: {} } }, { report: { total: 0, reached: false, verdict: 'none', rows: [], summary: null }, summary: 'x' }])).toEqual(['$[0].a.internal', '$[1].summary']);
  });
  it('a whole teacher journey leaks no internal key; scenario rows pass ScenarioPublic.extend({group_ids}).strict()', async () => {
    const store = new Store(memoryStorage(), () => seedDb(T0));
    const admin = createMockApi({ realm: 'admin', store, now: () => T0, adminPassword: ADMIN_PW });
    const teacher = createMockApi({ realm: 'teacher', store, now: () => T0, adminPassword: ADMIN_PW });
    await admin.adminLogin({ nickname: 'admin', password: ADMIN_PW });
    const ids = Object.fromEntries((await admin.listScenarios()).map(s => [s.slug, s.id]));

    const seen: unknown[] = [];
    const keep = async <X>(p: Promise<X>) => { const x = await p; seen.push(x); return x; };
    const me = await keep(teacher.signup({ nickname: 'Haneul', password: 'abcd1234' }));
    await admin.createGroup({ name: 'A반', member_ids: [me.id], scenario_ids: [ids.gabriel, ids.hajun] });
    await keep(teacher.me());
    const home = await keep(teacher.getPractice());
    expect(home.scenarios.map(s => s.slug).sort()).toEqual(['gabriel', 'hajun']);
    for (const s of home.scenarios) S.ScenarioPublic.extend({ group_ids: S.PracticeHome.shape.scenarios.element.shape.group_ids }).strict().parse(s);

    for (const slug of ['gabriel', 'hajun']) {   // with and without classification criteria
      const d = await keep(teacher.startSession({ scenario_id: ids[slug] }));
      await keep(teacher.getCurrentSession());
      for (const text of slug === 'gabriel' ? [...L1, '도와줘', '통분하면 돼.'] : ['어떻게 풀었는지 말해 줄래?']) {
        for await (const ev of teacher.sendTurn(d.session.id, { text })) { S.SseEvent.parse(ev); seen.push(ev); }
      }
      if (slug === 'gabriel') for await (const ev of teacher.sendTurn(d.session.id, { text: 'END SESSION' })) seen.push(ev);
      else await keep(teacher.endSession(d.session.id));
      await keep(teacher.getSession(d.session.id));
    }
    await keep(teacher.getCurrentSession());
    await keep(teacher.listSessions());

    expect(seen.some(x => x && typeof x === 'object' && 'type' in x && x.type === 'trigger')).toBe(true);   // the walk did cover mentor turns
    expect(seen.some(x => x && typeof x === 'object' && 'report' in x && x.report)).toBe(true);          // …and a report
    expect(leaks(seen)).toEqual([]);
  });
});
