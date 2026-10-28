// 관리자 AI 설정 (G-28, O-7, 티켓 18): 목 updateAi 와 같은 검증·같은 감사 meta. 실제 호출은 3단계.
// 키 원문은 버린다(O-7): 마스킹·등록일만 저장하고 key_ciphertext 는 쓰지도 읽지도 않는다(null 유지, AI-3). 원문은 로그·감사에도 넣지 않는다.
import * as S from '@remath/shared';
import type { z } from 'zod';
import type { Deps, Handlers } from '../app.ts';
import { audit } from '../audit.ts';
import { must } from '../db.ts';
import { ApiFail } from '../errors.ts';

type Setting = z.infer<typeof S.AiRoleSetting>;
type Settings = z.infer<typeof S.AiSettings>;
const AI_COLS = 'role, key_source, provider, key_masked, key_added_at, model, effort';
const no = (code: S.ErrorCode, message: string, details?: unknown): never => { throw new ApiFail(code, message, details); };

/** 목 updateAi 의 규칙(순수). rows = 이 역할 + 이 역할의 키를 함께 쓰던 역할(공급자가 따라 바뀐다). */
export function updateAi(ai: Settings, role: string, b: z.infer<typeof S.AiRoleInput>, providers: z.infer<typeof S.ProvidersFile>, now: string) {
  const r = S.AiRoleSetting.shape.role.safeParse(role), key = b.api_key?.trim();
  const cur = r.success ? ai[r.data] : no('not_found', 'not_found');
  if (key && b.key_source !== 'own') no('validation_failed', 'api_key is only for key_source=own');
  if (b.key_source === role) no('validation_failed', 'a role cannot share its own key');
  const keyProvider = key ? S.detectProvider(key) ?? no('validation_failed', 'unrecognized key format') : null;
  const src = b.key_source === 'own' ? null : ai[b.key_source];
  if (src && (src.key_source !== 'own' || !src.provider)) no('validation_failed', 'the source role has no key of its own');
  const provider = keyProvider ?? (src ? src.provider : cur.key_source === 'own' ? cur.provider : null);
  // effort: null = 공급자 기본값(통과). 목록 모델은 그 모델 집합, 직접 입력은 공급자 집합(D-20). 키가 없어 공급자를 모르면 enum 검증만(티켓 18).
  const P = provider && providers[provider], allowed = P ? P.models.find(m => m.id === b.model)?.efforts ?? P.efforts : null;
  if (allowed && b.effort !== null && !allowed.includes(b.effort)) no('invalid_effort', 'effort not allowed for this model', { allowed });
  const masked = src ? null : key ? S.maskKey(key) : cur.key_masked;
  const next: Setting = { ...cur, key_source: b.key_source, provider, key_masked: masked, key_added_at: src ? null : key ? now : cur.key_added_at, model: b.model, effort: b.effort };
  const sharing = Object.values(ai).filter(x => x.key_source === role).map(x => ({ ...x, provider: next.key_source === 'own' ? provider : null }));
  return { rows: [next, ...sharing], meta: { provider, model: b.model, effort: b.effort, key_source: b.key_source, key_masked: masked, key_changed: masked !== cur.key_masked || !!key } };
}

export function adminAiHandlers({ db, config, now }: Deps): Handlers {
  const settings = async () =>
    Object.fromEntries((must(await db.from('ai_settings').select(AI_COLS)) as Setting[]).map(r => [r.role, r])) as Settings;
  return {
    'GET /api/admin/ai': settings,
    /** 바뀌는 행들은 upsert 한 문장(= 한 트랜잭션)으로. 응답은 DB 가 돌려준 행(이후 GET 과 같은 시각 표기). */
    'PUT /api/admin/ai/:role': async req => {
      const { role } = req.params as { role: string };
      const { rows, meta } = updateAi(await settings(), role, req.body as z.infer<typeof S.AiRoleInput>, config.providers, now().toISOString());
      const saved = must(await db.from('ai_settings').upsert(rows, { onConflict: 'role' }).select(AI_COLS)) as Setting[];
      await audit(db, req.log, { actor_id: req.auth!.user.id, action: 'ai.update', target: role, meta });
      return saved.find(x => x.role === role);
    },
    'GET /api/admin/ai/providers': async () => config.providers,
  };
}
