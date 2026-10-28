// 투영: 저장소 행 → 응답 모양(예비교사용은 scenarios_public 뷰 열만). 쓰기 없음.
import { checkTemplates, compileScenario } from '@remath/prompts';
import * as S from '@remath/shared';
import type { z } from 'zod';
import { fail, type Ctx } from './context.ts';
import type { GroupRow, ScenarioRow, SessionRow, UserRow } from './store.ts';

export type Projection = ReturnType<typeof projection>;
export function projection(c: Ctx) {
  const { db } = c;
  const groupsOf = (pred: (g: GroupRow) => boolean) => db.groups.filter(pred).map(g => ({ id: g.id, name: g.name }));
  const tr = (s: ScenarioRow) => s.translations[s.lang];
  const compile = (s: ScenarioRow) => compileScenario(s, tr(s), s.lang, c.templates);
  const review = (s: ScenarioRow) => S.autoChecks(s, checkTemplates(c.templates).every(x => x.ok));
  const sessionCount = (sid: string) => db.sessions.filter(x => x.scenario_id === sid).length;
  const scenario = (id: string) => db.scenarios.find(s => s.id === id) ?? fail('not_found');
  const toAdmin = ({ compiled_prompt: _, ...s }: ScenarioRow): z.infer<typeof S.ScenarioAdmin> =>
    ({ ...s, groups: groupsOf(g => g.scenario_ids.includes(s.id)), session_count: sessionCount(s.id) });
  const toSummary = (s: ScenarioRow): z.infer<typeof S.ScenarioSummary> => ({
    id: s.id, slug: s.slug, status: s.status, lang: s.lang, student_prefix: s.student_prefix, grade: s.grade, name: tr(s).name, problem: tr(s).problem,
    misconception_count: s.internal.misconceptions.length,
    classification_count: { leverage: s.classification.leverage.length, object: s.classification.object.length },
    groups: groupsOf(g => g.scenario_ids.includes(s.id)), session_count: sessionCount(s.id), updated_at: s.updated_at,
  });
  const turnsOf = (sid: string) => db.turns.filter(t => t.session_id === sid).sort((a, b) => a.seq - b.seq);
  const teacherCount = (ts: { speaker: string }[]) => ts.filter(t => t.speaker === 'teacher').length;
  /** turn_count = 예비교사 발화 수(END SESSION 은 기록되지 않으므로 자연히 제외, D-15). */
  const sessionRow = (s: SessionRow): z.infer<typeof S.SessionRow> => {
    const sc = db.scenarios.find(x => x.id === s.scenario_id)!, u = db.users.find(x => x.id === s.user_id)!;
    return { id: s.id, scenario_id: s.scenario_id, scenario_name: sc.translations[s.lang].name, lang: s.lang, user_id: s.user_id, nickname: u.nickname,
      started_at: s.started_at, ended_at: s.ended_at, goal_reached: s.goal_reached, turn_count: teacherCount(turnsOf(s.id)) };
  };
  const detail = (s: SessionRow): z.infer<typeof S.SessionDetail> =>
    ({ session: sessionRow(s), turns: turnsOf(s.id).map(({ session_id: _, ...t }) => t), report: s.report, turn_limit: c.turnLimit });
  const userRow = (u: UserRow): z.infer<typeof S.UserRow> => {
    const gs = db.groups.filter(g => g.member_ids.includes(u.id));
    return { id: u.id, nickname: u.nickname, groups: groupsOf(g => gs.includes(g)), scenario_count: new Set(gs.flatMap(g => g.scenario_ids)).size,
      session_count: db.sessions.filter(s => s.user_id === u.id).length, created_at: u.created_at, pw_updated_at: u.pw_updated_at };
  };
  const groupOut = (g: GroupRow): z.infer<typeof S.Group> => ({
    id: g.id, name: g.name,
    members: g.member_ids.map(id => ({ id, nickname: db.users.find(u => u.id === id)?.nickname ?? '?' })),
    scenarios: g.scenario_ids.flatMap(id => { const s = db.scenarios.find(x => x.id === id); return s ? [{ id, name: tr(s).name, lang: s.lang, status: s.status }] : []; }),
  });
  return { groupsOf, tr, compile, review, sessionCount, scenario, toAdmin, toSummary, turnsOf, teacherCount, sessionRow, detail, userRow, groupOut };
}
