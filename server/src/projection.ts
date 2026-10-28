// 투영 (E-19, M-10): Data API 조인 결과 → 목 projection.ts 와 같은 응답 모양. 순수 함수, 쓰기 없음.
// 각 SELECT 상수가 그 행 타입의 모양을 만든다(PostgREST 임베드). 둘을 함께 고친다.
import * as S from '@remath/shared';
import type { z } from 'zod';

type Lang = 'ko' | 'en';
type Translation = z.infer<typeof S.Translation>;
type Count = { count: number }[];   // PostgREST `rel(count)`
const count = (c: Count) => c[0]?.count ?? 0;
type Ref = { id: string; name: string };

const TR_COLS = 'lang, name, description, problem, chars, greet, aha, t1, t2, t3, confused, elicit, misconceptions';
export const SCENARIO_SELECT = `id, slug, status, lang, student_prefix, mentor_prefix, grade, internal, classification, compiled_prompt, created_at, updated_at,
  scenario_translations(${TR_COLS}), group_scenarios(groups(id, name)), sessions(count)`;
export type ScenarioDbRow = Omit<z.infer<typeof S.ScenarioAdmin>, 'translations' | 'groups' | 'session_count'> & {
  compiled_prompt: z.infer<typeof S.Compiled> | null;
  scenario_translations: (Translation & { lang: Lang })[];
  group_scenarios: { groups: Ref }[];
  sessions: Count;
};

/** scenario_translations 2행 → 인라인 {ko, en}. */
/** 행이 빠진 언어판(실패한 생성의 잔여)은 빈 판으로 채워 목록 전체가 500 이 되지 않게 한다. */
export const translations = (rows: ScenarioDbRow['scenario_translations']) =>
  ({ ko: S.Translation.parse({}), en: S.Translation.parse({}), ...Object.fromEntries(rows.map(({ lang, ...t }) => [lang, t])) }) as Record<Lang, Translation>;
/** compileScenario·autoChecks 가 받는 ScenarioInput 모양. */
export const toInput = (s: ScenarioDbRow): z.infer<typeof S.ScenarioInput> => ({
  lang: s.lang, student_prefix: s.student_prefix, mentor_prefix: s.mentor_prefix, grade: s.grade,
  internal: s.internal, classification: s.classification, translations: translations(s.scenario_translations),
});

/** 목 toAdmin: compiled_prompt 를 뺀다. */
export const toAdmin = (s: ScenarioDbRow): z.infer<typeof S.ScenarioAdmin> => ({
  ...toInput(s), id: s.id, slug: s.slug, status: s.status, created_at: s.created_at, updated_at: s.updated_at,
  groups: s.group_scenarios.map(g => g.groups), session_count: count(s.sessions),
});

export const toSummary = (s: ScenarioDbRow): z.infer<typeof S.ScenarioSummary> => {
  const t = translations(s.scenario_translations)[s.lang];
  return {
    id: s.id, slug: s.slug, status: s.status, lang: s.lang, student_prefix: s.student_prefix, grade: s.grade, name: t.name, problem: t.problem,
    misconception_count: s.internal.misconceptions.length,
    classification_count: { leverage: s.classification.leverage.length, object: s.classification.object.length },
    groups: s.group_scenarios.map(g => g.groups), session_count: count(s.sessions), updated_at: s.updated_at,
  };
};

export const USER_SELECT = 'id, nickname, created_at, pw_updated_at, group_members(groups(id, name, group_scenarios(scenario_id))), sessions(count)';
export interface UserDbRow {
  id: string; nickname: string; created_at: string; pw_updated_at: string; sessions: Count;
  group_members: { groups: Ref & { group_scenarios: { scenario_id: string }[] } }[];
}

/** scenario_count = 소속 그룹 시나리오의 중복 제거 수. */
export const userRow = (u: UserDbRow): z.infer<typeof S.UserRow> => {
  const gs = u.group_members.map(m => m.groups);
  return {
    id: u.id, nickname: u.nickname, groups: gs.map(g => ({ id: g.id, name: g.name })),
    scenario_count: new Set(gs.flatMap(g => g.group_scenarios.map(x => x.scenario_id))).size,
    session_count: count(u.sessions), created_at: u.created_at, pw_updated_at: u.pw_updated_at,
  };
};

export const GROUP_SELECT = 'id, name, group_members(users(id, nickname)), group_scenarios(scenarios(id, lang, status, scenario_translations(lang, name)))';
export interface GroupDbRow {
  id: string; name: string;
  group_members: { users: { id: string; nickname: string } }[];
  group_scenarios: { scenarios: { id: string; lang: Lang; status: 'draft' | 'published'; scenario_translations: { lang: Lang; name: string }[] } }[];
}

/** 시나리오 이름은 활성 언어판. */
export const groupOut = (g: GroupDbRow): z.infer<typeof S.Group> => ({
  id: g.id, name: g.name,
  members: g.group_members.map(m => m.users),
  scenarios: g.group_scenarios.map(({ scenarios: s }) =>
    ({ id: s.id, name: s.scenario_translations.find(t => t.lang === s.lang)?.name ?? '', lang: s.lang, status: s.status })),
});
