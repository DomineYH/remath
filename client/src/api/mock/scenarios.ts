// 관리자 — 시나리오 (G-34·F-31): 목록·초안 저장·삭제·검수·게시·컴파일 전문.
import type { Api } from '../types.ts';
import { audit } from './audit.ts';
import { fail, type Ctx } from './context.ts';
import type { Projection } from './projection.ts';
import type { ScenarioRow } from './store.ts';

export function scenarios(c: Ctx, p: Projection) {
  const { db, now, uuid, save, who } = c;
  const { compile, review, scenario, sessionCount, toAdmin, toSummary } = p;
  return {
    listScenarios: async () => [...db.scenarios].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(toSummary),
    /** 새 시나리오는 초안, slug 는 서버가 만든다. */
    createScenario: async b => {
      const a = who('admin'), t = now(), id = uuid();
      const s: ScenarioRow = { ...b, id, slug: `scenario-${id.slice(0, 8)}`, status: 'draft', compiled_prompt: null, created_at: t, updated_at: t };
      db.scenarios.push(s); audit(db, t, { actor_id: a.id, action: 'scenario.create', target: id, meta: { slug: s.slug } }); save();
      return toAdmin(s);
    },
    getScenario: async id => toAdmin(scenario(id)),
    /** 초안 저장 = 항상 draft + compiled_prompt null: 게시본은 내려간다(G-34, 사용자 스토리 52). */
    updateScenario: async (id, b) => {
      const a = who('admin'), s = scenario(id);
      Object.assign(s, b, { status: 'draft', compiled_prompt: null, updated_at: now() });
      audit(db, now(), { actor_id: a.id, action: 'scenario.update', target: id, meta: { slug: s.slug } }); save();
      return toAdmin(s);
    },
    /** 기록이 있으면 409(보관 상태 없음, 티켓 10·11). 그룹 할당은 함께 지운다(FK cascade). */
    deleteScenario: async id => {
      const a = who('admin'), s = scenario(id), session_count = sessionCount(id);
      if (session_count) fail('scenario_has_sessions', 'scenario has sessions', { session_count });
      db.scenarios = db.scenarios.filter(x => x.id !== id);
      for (const g of db.groups) g.scenario_ids = g.scenario_ids.filter(x => x !== id);
      audit(db, now(), { actor_id: a.id, action: 'scenario.delete', target: id, meta: { slug: s.slug } }); save();
    },
    reviewScenario: async id => review(scenario(id)),
    /** 자동 점검 fail 이 있거나 확인 m1~m4 가 다 없으면 422(details = ReviewResult). 통과하면 게시와 같은 compileScenario 로 컴파일해 저장(F-31). */
    publishScenario: async (id, b) => {
      const a = who('admin'), s = scenario(id), r = review(s);
      if (!r.publishable || new Set(b.confirmed).size < 4) fail('review_failed', 'review failed', r);
      const t = now();
      Object.assign(s, { status: 'published', compiled_prompt: compile(s), updated_at: t });
      audit(db, t, { actor_id: a.id, action: 'scenario.publish', target: id, meta: { slug: s.slug, lang: s.lang } }); save();
      return toAdmin(s);
    },
    // 저장된 컴파일(게시본) 또는 초안을 활성 언어판으로 컴파일한 전문(F-31).
    getScenarioPrompt: async id => { const s = scenario(id); return s.compiled_prompt ?? compile(s); },
  } satisfies Partial<Api>;
}
