// 관리자 — 사용자·그룹·AI 설정. AI 키 원문은 저장소에 남기지 않는다: 마스킹·등록일만(D-20·G-37).
import providers from '@remath/shared/providers.json';
import * as S from '@remath/shared';
import type { z } from 'zod';
import type { Api } from '../types.ts';
import { audit } from './audit.ts';
import type { auth } from './auth.ts';
import { fail, type Ctx } from './context.ts';
import type { Projection } from './projection.ts';
import type { GroupRow, UserRow } from './store.ts';

export function admin(c: Ctx, p: Projection, { addTeacher, setPassword }: Pick<ReturnType<typeof auth>, 'addTeacher' | 'setPassword'>) {
  const { db, now, uuid, save, who } = c;
  const { userRow, groupOut } = p;
  const teacher = (id: string) => db.users.find(u => u.id === id && u.role === 'teacher') ?? fail('not_found');
  const group = (id: string) => db.groups.find(g => g.id === id) ?? fail('not_found');
  /** 없는 id·관리자를 구성원으로 넣으면 400(서버의 FK·역할 검사). 중복 id 는 하나로. */
  const groupInput = (b: z.infer<typeof S.GroupInput>) => {
    const member_ids = [...new Set(b.member_ids)], scenario_ids = [...new Set(b.scenario_ids)];
    const known = member_ids.every(id => db.users.some(u => u.id === id && u.role === 'teacher')) && scenario_ids.every(id => db.scenarios.some(s => s.id === id));
    if (!known) fail('validation_failed', 'unknown member or scenario id');
    return { name: b.name, member_ids, scenario_ids };
  };
  const groupAudit = (a: UserRow, action: 'group.create' | 'group.update' | 'group.delete', g: GroupRow) =>
    audit(db, now(), { actor_id: a.id, action, target: g.id, meta: { name: g.name, member_count: g.member_ids.length, scenario_count: g.scenario_ids.length } });

  const providersFile = S.ProvidersFile.parse(providers);
  const updateAi = (role: 'student' | 'mentor' | 'analysis', b: z.infer<typeof S.AiRoleInput>) => {
    const a = who('admin'), cur = db.ai[role] ?? fail('not_found'), key = b.api_key?.trim();
    if (key && b.key_source !== 'own') fail('validation_failed', 'api_key is only for key_source=own');
    if (b.key_source === role) fail('validation_failed', 'a role cannot share its own key');
    const keyProvider = key ? S.detectProvider(key) ?? fail('validation_failed', 'unrecognized key format') : null;
    const src = b.key_source === 'own' ? null : db.ai[b.key_source];
    if (src && (src.key_source !== 'own' || !src.provider)) fail('validation_failed', 'the source role has no key of its own');
    const provider = keyProvider ?? (src ? src.provider : cur.key_source === 'own' ? cur.provider : null);
    // effort: null = 공급자 기본값(통과). 목록 모델은 그 모델 집합, 직접 입력은 공급자 집합(D-20). 키가 없어 공급자를 모르면 enum 검증만(티켓 18).
    const P = provider && providersFile[provider], allowed = P ? P.models.find(m => m.id === b.model)?.efforts ?? P.efforts : null;
    if (allowed && b.effort !== null && !allowed.includes(b.effort)) fail('invalid_effort', 'effort not allowed for this model', { allowed });
    const masked = src ? null : key ? S.maskKey(key) : cur.key_masked;
    const next = { ...cur, key_source: b.key_source, provider, key_masked: masked, key_added_at: src ? null : key ? now() : cur.key_added_at, model: b.model, effort: b.effort };
    db.ai[role] = next;
    for (const r of Object.values(db.ai)) if (r.key_source === role) r.provider = next.key_source === 'own' ? provider : null;   // 이 키를 함께 쓰던 역할
    audit(db, now(), { actor_id: a.id, action: 'ai.update', target: role,
      meta: { provider, model: b.model, effort: b.effort, key_source: b.key_source, key_masked: masked, key_changed: masked !== cur.key_masked || !!key } });
    save(); return { ...next };
  };

  return {
    listUsers: async () => db.users.filter(u => u.role === 'teacher').map(userRow),
    createUser: async b => {
      const a = who('admin'), u = await addTeacher(b);
      audit(db, u.created_at, { actor_id: a.id, action: 'user.create', target: u.id, meta: { nickname: u.nickname } }); save();
      return userRow(u);
    },
    /** 재설정 = 그 사용자의 로그인 모두 종료(G-34). */
    resetUserPassword: async (id, b) => {
      const a = who('admin'), u = teacher(id), t = now();
      await setPassword(u, b.password, t);
      db.auth_sessions = db.auth_sessions.filter(s => s.user_id !== id);
      audit(db, t, { actor_id: a.id, action: 'user.password_reset', target: id, meta: { nickname: u.nickname } }); save();
    },
    /** cascade: 연습 세션·발화·그룹 구성원·로그인(USR-1). */
    deleteUser: async id => {
      const a = who('admin'), u = teacher(id), sids = new Set(db.sessions.filter(s => s.user_id === id).map(s => s.id));
      db.users = db.users.filter(x => x.id !== id);
      db.sessions = db.sessions.filter(s => !sids.has(s.id)); db.turns = db.turns.filter(x => !sids.has(x.session_id));
      db.auth_sessions = db.auth_sessions.filter(s => s.user_id !== id);
      for (const g of db.groups) g.member_ids = g.member_ids.filter(m => m !== id);
      audit(db, now(), { actor_id: a.id, action: 'user.delete', target: id, meta: { nickname: u.nickname, session_count: sids.size } }); save();
    },
    listGroups: async () => db.groups.map(groupOut),
    createGroup: async b => {
      const a = who('admin'), t = now(), g: GroupRow = { id: uuid(), ...groupInput(b), created_at: t, updated_at: t };
      db.groups.push(g); groupAudit(a, 'group.create', g); save(); return groupOut(g);
    },
    /** 구성원·시나리오 전체 치환(G-34). */
    updateGroup: async (id, b) => {
      const a = who('admin'), g = group(id);
      Object.assign(g, groupInput(b), { updated_at: now() }); groupAudit(a, 'group.update', g); save(); return groupOut(g);
    },
    deleteGroup: async id => {
      const a = who('admin'), g = group(id);
      db.groups = db.groups.filter(x => x.id !== id); groupAudit(a, 'group.delete', g); save();
    },
    getAiSettings: async () => structuredClone(db.ai),
    updateAiRole: async (role, b) => updateAi(role, b), getProviders: async () => providersFile,
  } satisfies Partial<Api>;
}
