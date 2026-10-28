// API 계약 (티켓 10 + 14·15·18·19·20 덧붙임) — zod 스키마 모음.
// 서버(Fastify + fastify-type-provider-zod)와 클라이언트(client/src/api/ HTTP·목 구현)가 같은 타입을 본다.
// 키는 DB 컬럼과 같은 snake_case: scenarios_public 뷰의 컬럼 집합이 곧 예비교사 응답 타입이다(ADR-0003). 매핑 계층 없음.
import { z } from 'zod';
import { TRIGGER } from '../leverage.ts';

// ---- 공통 ---------------------------------------------------------------------
export const Lang = z.enum(['ko', 'en']);
export const Uuid = z.string().uuid();
export const Iso = z.string().datetime({ offset: true });
const TriggerNo = z.union([z.literal(TRIGGER.takingOver), z.literal(TRIGGER.help), z.literal(TRIGGER.goal)]);

/** PRD 9절: 2~16자, 한글·영문·숫자·_ . -, @ 불가, 숫자 7자리 이상 연속 불가. 중복(대소문자 무시)은 서버가 409. */
export const Nickname = z.string().regex(/^[A-Za-z0-9가-힣_.-]{2,16}$/).refine(s => !/\d{7}/.test(s), 'no 7+ consecutive digits');
/** PRD 9절·AUTH-2: 8자 이상, 영문+숫자 필수, 특수문자 허용, 공백 불가. */
export const Password = z.string().min(8).regex(/^\S+$/).regex(/[A-Za-z]/).regex(/\d/);
/** 화면의 실시간 규칙 3개(8자 이상 · 영문+숫자 · 공백 없음). `Password` 와 같은 규칙이라 화면과 목이 어긋나지 않는다(schemas.test 가 확인). */
export const passwordChecks = (p: string): [boolean, boolean, boolean] => [p.length >= 8, /[A-Za-z]/.test(p) && /\d/.test(p), /^\S+$/.test(p)];

/** 모든 오류 응답 본문. HTTP 상태는 code 가 정한다(SPEC 4절 표). */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),                 // 'validation_failed' | 'unauthorized' | 'forbidden' | 'not_found' | 'nickname_taken' | ...
    message: z.string(),              // 사람용, 화면 언어와 무관한 영어 한 줄. 화면 문구는 클라이언트 사전이 code 로 고른다
    details: z.unknown().optional(),  // validation_failed: zod issues / review_failed: ReviewResult / turn_in_progress: {turn_started_at}
  }),
});

// ---- 인증 (예비교사 /api/auth/*, 관리자 /api/admin/auth/*) ----------------------------
export const Credentials = z.object({ nickname: Nickname, password: Password });
export const Me = z.object({ id: Uuid, nickname: z.string(), role: z.enum(['teacher', 'admin']), pw_updated_at: Iso });
export const PasswordChange = z.object({ current: z.string(), next: Password });
export const PasswordReset = z.object({ password: Password });   // 관리자가 사용자 비밀번호 재설정(USR-1)

// ---- 시나리오: 관리자 전용 형태 -----------------------------------------------------
export const ClassificationRow = z.object({ name: z.string().min(1), desc: z.string().default(''), ex: z.string().default('') });
export const Classification = z.object({ leverage: z.array(ClassificationRow), object: z.array(ClassificationRow) });

/** scenarios.internal — 내부 설정. 예비교사 응답에는 절대 없다. 키는 티켓 9 플레이스홀더 출처 표. */
export const Internal = z.object({
  baseline: z.string().default(''), drawing: z.string().default(''), reasoning: z.string().default(''),
  never: z.string().default(''), goal: z.string().default(''), prog: z.string().default(''),
  misconceptions: z.array(z.object({ text: z.string() })).default([]),
});
/** scenario_translations 한 언어판. `desc`→`description`(티켓 11). */
export const Translation = z.object({
  name: z.string().default(''), description: z.string().default(''), problem: z.string().default(''), chars: z.string().default(''),
  greet: z.string().default(''), aha: z.string().default(''), t1: z.string().default(''), t2: z.string().default(''), t3: z.string().default(''),
  confused: z.array(z.string()).default([]), elicit: z.array(z.string()).default([]),
  misconceptions: z.array(z.object({ kw: z.string(), h: z.string(), c: z.string() })).default([]),
});
/** 위자드 저장 본문(초안 저장·게시 전 상태). 두 언어판을 항상 함께 보낸다(SCN-2). */
const ScenarioBase = z.object({
  lang: Lang, student_prefix: z.string(), mentor_prefix: z.string(), grade: z.string(),
  internal: Internal, classification: Classification,
  translations: z.object({ ko: Translation, en: Translation }),
});
export const ScenarioInput = ScenarioBase.refine(s => [s.translations.ko, s.translations.en].every(t => t.misconceptions.length === s.internal.misconceptions.length),
  'translations.*.misconceptions must align with internal.misconceptions');

export const Compiled = z.object({ student: z.string(), analysis: z.string().nullable(), mentor: z.string() });
export const ScenarioAdmin = ScenarioBase.extend({
  id: Uuid, slug: z.string(), status: z.enum(['draft', 'published']), created_at: Iso, updated_at: Iso,
  groups: z.array(z.object({ id: Uuid, name: z.string() })),
  session_count: z.number().int().nonnegative(),
});
/** 목록 카드(PRD 3절, I-43): 이모지·이름·학년·문제·상태·언어·오개념 수·분류 수·이용 그룹. 활성 언어판 문구만. */
export const ScenarioSummary = z.object({
  id: Uuid, slug: z.string(), status: z.enum(['draft', 'published']), lang: Lang, student_prefix: z.string(), grade: z.string(),
  name: z.string(), problem: z.string(), misconception_count: z.number().int().nonnegative(),
  classification_count: z.object({ leverage: z.number().int(), object: z.number().int() }),
  groups: z.array(z.object({ id: Uuid, name: z.string() })), session_count: z.number().int().nonnegative(), updated_at: Iso,
});
/** 검수(SCN-4): 자동 점검 c1~c6(목업) + c7 두 판 템플릿 구조 일치(티켓 9). 관리자 확인 m1~m4 는 게시 본문으로 받는다. */
export const ReviewResult = z.object({
  auto: z.array(z.object({ id: z.enum(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']), status: z.enum(['pass', 'fail', 'info']) })),
  publishable: z.boolean(),           // auto 에 fail 이 없음
});
export const PublishBody = z.object({ confirmed: z.array(z.enum(['m1', 'm2', 'm3', 'm4'])) });

// ---- 시나리오: 예비교사 형태 = scenarios_public 뷰 컬럼 그대로 ------------------------------
export const ScenarioPublic = z.object({
  id: Uuid, slug: z.string(), status: z.literal('published'), lang: Lang, student_prefix: z.string(), mentor_prefix: z.string(), grade: z.string(),
  classification: Classification,     // [CLASSIFICATION] 토글·분석 여부 표시용. 분류명·설명·예시는 공개 정보(목업과 동일)
  name: z.string(), description: z.string(), problem: z.string(), chars: z.string(), greet: z.string(), elicit: z.array(z.string()),
  created_at: Iso, updated_at: Iso,
});
type ScenarioCols = z.infer<typeof ScenarioBase> & { id: string; slug: string; created_at: string; updated_at: string };
/** scenarios_public 뷰의 한 행: 시나리오 열 + 한 언어판의 공개 문구(기본은 활성 언어판). 내부 설정·나머지 대사는 빠진다. status 는 뷰가 게시본만 담아 상수. */
export function scenarioPublic(s: ScenarioCols, lang: z.infer<typeof Lang> = s.lang): z.infer<typeof ScenarioPublic> {
  const t = s.translations[lang];
  return { id: s.id, slug: s.slug, status: 'published', lang, student_prefix: s.student_prefix, mentor_prefix: s.mentor_prefix, grade: s.grade, classification: s.classification,
    name: t.name, description: t.description, problem: t.problem, chars: t.chars, greet: t.greet, elicit: t.elicit, created_at: s.created_at, updated_at: s.updated_at };
}
export const PracticeHome = z.object({
  groups: z.array(z.object({ id: Uuid, name: z.string() })),              // 0개면 "그룹 없음" 안내
  scenarios: z.array(ScenarioPublic.extend({ group_ids: z.array(Uuid) })), // groups 가 있는데 0개면 "할당 없음" 안내
});

// ---- 연습 세션·발화 -----------------------------------------------------------------
export const Turn = z.object({
  seq: z.number().int().positive(), speaker: z.enum(['teacher', 'student', 'mentor']), text: z.string(),
  leverage: z.string().nullable(), object: z.string().nullable(), trigger: TriggerNo.nullable(),
  created_at: Iso,
});
export const Verdict = z.enum(['none', 'clean', 'mixed', 'heavy', 'dist']);
/** 티켓 14 확정 그대로. */
export const SessionReport = z.object({
  total: z.number().int().nonnegative(), reached: z.boolean(), verdict: Verdict,
  rows: z.array(z.object({ name: z.string(), desc: z.string(), count: z.number().int().nonnegative(), turns: z.array(z.object({ seq: z.number().int(), text: z.string() })) })),
  summary: z.string().max(1000).nullable(),
});
/** 목록 행(내 기록·관리자 대화 기록 공용). 내부 상태(progress·counts) 없음. */
export const SessionRow = z.object({
  id: Uuid, scenario_id: Uuid, scenario_name: z.string(), lang: Lang, user_id: Uuid, nickname: z.string(),
  started_at: Iso, ended_at: Iso.nullable(), goal_reached: z.boolean(), turn_count: z.number().int().nonnegative(),
});
/** turn_count = 예비교사 발화 수(END SESSION 제외). 상한에 닿으면 422 turn_limit_reached, details = {turn_count, turn_limit} (티켓 19). */
export const SessionDetail = z.object({ session: SessionRow, turns: z.array(Turn), report: SessionReport.nullable(), turn_limit: z.number().int().positive() });
export const StartSession = z.object({ scenario_id: Uuid });
export const TurnBody = z.object({ text: z.string().trim().min(1).max(2000) });

// ---- 턴 SSE 이벤트 (C7) — `event: <type>` / `data: <json>` ----------------------------------
// student·mentor 는 청크를 여러 번(final:false) 흘린 뒤 전문 하나(final:true)를 낸다. MOCK 은 final 하나만. 클라이언트는 final 로 치환한다.
export const SseEvent = z.union([   // done 이 ended 로 두 갈래라 discriminatedUnion 대신 union
  z.object({ type: z.literal('classification'), leverage: z.string(), object: z.string().nullable() }),  // 분류 기준 없으면 이벤트 자체가 없음
  z.object({ type: z.literal('student'), text: z.string(), final: z.boolean() }),
  z.object({ type: z.literal('trigger'), trigger: TriggerNo }),
  z.object({ type: z.literal('mentor'), text: z.string(), final: z.boolean() }),
  z.object({ type: z.literal('done'), ended: z.literal(false), turns: z.array(Turn) }),                 // 이번 한 턴에 기록된 발화(예비교사·학생·멘토)
  z.object({ type: z.literal('done'), ended: z.literal(true), report: SessionReport.nullable() }),      // END SESSION 발화 턴. 발화는 기록하지 않음
  z.object({ type: z.literal('error'), code: z.string(), message: z.string(), retryable: z.boolean() }), // 이후 스트림 종료. 이 턴의 발화는 하나도 기록되지 않음
  // 관리자 전용 `state` 이벤트는 아래 AdminSseEvent(티켓 15). 예비교사 유니온에는 넣지 않는다
]);

// ---- 관리자 대화 테스트 내부 상태 패널 (티켓 15) ---------------------------------------
export const AdminState = z.object({
  mis: z.array(z.number().int().min(0).max(2)),          // 오개념별 카운터, 순서 = internal.misconceptions (ADR-0002)
  counts: z.record(z.string(), z.number().int().nonnegative()), // 레버리지별 누적 (= sessions.counts)
  goal_reached: z.boolean(),
  last_trigger: TriggerNo.nullable(), // 세션 전체의 마지막 트리거 (turns.trigger 최신 non-null 행)
});
export const AdminSseEvent = z.union([...SseEvent.options, AdminState.extend({ type: z.literal('state') })]);
export const AdminSessionDetail = SessionDetail.extend({ state: AdminState });

// ---- 관리자: 사용자·그룹·기록·AI 설정 -------------------------------------------------------
export const UserRow = z.object({
  id: Uuid, nickname: z.string(), groups: z.array(z.object({ id: Uuid, name: z.string() })),
  scenario_count: z.number().int().nonnegative(), session_count: z.number().int().nonnegative(), created_at: Iso, pw_updated_at: Iso,
});
export const Group = z.object({
  id: Uuid, name: z.string(),
  members: z.array(z.object({ id: Uuid, nickname: z.string() })),
  scenarios: z.array(z.object({ id: Uuid, name: z.string(), lang: Lang, status: z.enum(['draft', 'published']) })),
});
export const GroupInput = z.object({ name: z.string().trim().min(1).max(40), member_ids: z.array(Uuid), scenario_ids: z.array(Uuid) });
export const SessionFilter = z.object({ user_id: Uuid.optional(), scenario_id: Uuid.optional() });

export const Provider = z.enum(['openai', 'anthropic', 'gemini']);
export const Effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);   // 3사 합집합(티켓 12). 모델별 허용은 providers.json(티켓 18)

// ---- providers.json (티켓 18) — GET /api/admin/ai/providers 응답 그 자체 ---------------------
export const ProviderModel = z.object({
  id: z.string().min(1),
  efforts: z.array(Effort).nonempty(),
  default_effort: Effort.optional(),      // 없으면 UI에 (기본) 표시 없음. effort=null 저장 = 공급자 기본값(어댑터 생략)
  recommended: z.boolean().optional(),
}).refine(m => !m.default_effort || m.efforts.includes(m.default_effort));
export const ProviderEntry = z.object({
  name: z.string(),                       // 표시 이름
  param: z.string(),                      // 화면 힌트용 파라미터 이름(reasoning.effort 등)
  efforts: z.array(Effort).nonempty(),    // 공급자 전체 허용 집합 = 직접 입력 모델에 허용하는 집합
  models: z.array(ProviderModel).nonempty(),
}).refine(p => p.models.filter(m => m.recommended).length <= 1 && p.models.every(m => m.efforts.every(e => p.efforts.includes(e))));
export const ProvidersFile = z.object({ openai: ProviderEntry, anthropic: ProviderEntry, gemini: ProviderEntry }); // 키 = Provider enum, 3사 모두 필수
export const AiRoleSetting = z.object({
  role: z.enum(['student', 'mentor', 'analysis']), key_source: z.enum(['own', 'student', 'mentor', 'analysis']),
  provider: Provider.nullable(), key_masked: z.string().nullable(), key_added_at: Iso.nullable(),   // AI-3: 마스킹만. 원문·암호문 없음
  model: z.string().nullable(), effort: Effort.nullable(),
});
export const AiSettings = z.object({ student: AiRoleSetting, mentor: AiRoleSetting, analysis: AiRoleSetting });
/** 3단계 구현. api_key 는 key_source='own' 일 때만, 생략하면 기존 키 유지. */
export const AiRoleInput = z.object({
  key_source: z.enum(['own', 'student', 'mentor', 'analysis']), api_key: z.string().min(8).optional(),
  model: z.string().min(1), effort: Effort.nullable(),
});

/** 키 접두어 → 공급자(D-20·G-37): sk-ant- 를 sk- 보다 먼저 본다. 인식 불가 = null(저장은 400). 화면의 KeyDetect 와 목이 같은 규칙을 쓴다. */
export const detectProvider = (key: string): z.infer<typeof Provider> | null => {
  const k = key.trim();
  return k.startsWith('sk-ant-') ? 'anthropic' : k.startsWith('AIza') ? 'gemini' : k.startsWith('sk-') ? 'openai' : null;
};
/** 접두어 + … + 끝 4자. 키 원문 대신 저장·표시하는 유일한 값(AI-3). */
export const maskKey = (key: string) => { const k = key.trim(); return `${k.match(/^(sk-ant-|sk-proj-|sk-svcacct-|sk-|AIza)/)?.[0] ?? ''}…${k.slice(-4)}`; };

export const Csv = z.string(); // text/csv; charset=utf-8, BOM, 열 = C13

// ---- 감사 로그 (티켓 20) — 추가 전용, updated_at 없음 -------------------------------------------
export const AuditAction = z.enum([
  'scenario.create', 'scenario.update', 'scenario.publish', 'scenario.delete',
  'group.create', 'group.update', 'group.delete',
  'user.create', 'user.password_reset', 'user.delete',
  'ai.update', 'admin.password_reset', 'auth.login_failed', 'auth.password_change',
]);
/** meta 에 비밀번호·해시·토큰·발화 원문을 넣지 않는다. */
export const AuditEntry = z.object({
  id: Uuid, actor_id: Uuid.nullable(), action: AuditAction, target: z.string(),
  meta: z.record(z.string(), z.unknown()), created_at: Iso,
}).strict();
