// 관리자 — 사용자·그룹 (C-12, G-27, USR-1, GRP-2). 목 admin.ts 와 같은 규칙·같은 감사 meta.
import type * as S from '@remath/shared';
import argon2 from 'argon2';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Deps, Handlers } from '../app.ts';
import { audit } from '../audit.ts';
import { must } from '../db.ts';
import { ApiFail } from '../errors.ts';
import { GROUP_SELECT, groupOut, USER_SELECT, userRow, type GroupDbRow, type UserDbRow } from '../projection.ts';
import { idParam } from './admin-scenarios.ts';

type GroupInput = z.infer<typeof S.GroupInput>;

export function adminUserHandlers({ db }: Deps): Handlers {
  const actor = (req: FastifyRequest) => req.auth!.user.id;
  const teacher = async (id: string) => {
    const u = must(await db.from('users').select(USER_SELECT).eq('id', id).eq('role', 'teacher').maybeSingle()) as UserDbRow | null;
    if (!u) throw new ApiFail('not_found');
    return userRow(u);
  };
  const group = async (id: string) => {
    const g = must(await db.from('groups').select(GROUP_SELECT).eq('id', id).maybeSingle()) as GroupDbRow | null;
    if (!g) throw new ApiFail('not_found');
    return groupOut(g);
  };

  /** 없는 id·관리자를 구성원으로 넣으면 400. 중복 id 는 하나로. */
  const groupInput = async (b: GroupInput) => {
    const member_ids = [...new Set(b.member_ids)], scenario_ids = [...new Set(b.scenario_ids)];
    const [us, ss] = await Promise.all([
      member_ids.length ? db.from('users').select('id').eq('role', 'teacher').in('id', member_ids).then(must) : [],
      scenario_ids.length ? db.from('scenarios').select('id').in('id', scenario_ids).then(must) : [],
    ]);
    if (us!.length !== member_ids.length || ss!.length !== scenario_ids.length) throw new ApiFail('validation_failed', 'unknown member or scenario id');
    return { name: b.name, member_ids, scenario_ids };
  };
  /**
   * 구성원·시나리오 전체 치환. 새 연결을 먼저 넣고 빠진 것을 지워, 남는 구성원의 접근이 중간에 끊기지 않는다.
   * 중간에 실패하면 일부만 바뀐 채 500: 같은 요청을 다시 보내면 맞춰진다(멱등).
   */
  const link = async (gid: string, table: 'group_members' | 'group_scenarios', col: 'user_id' | 'scenario_id', ids: string[]) => {
    if (ids.length) must(await db.from(table).upsert(ids.map(x => ({ group_id: gid, [col]: x })), { onConflict: `group_id,${col}`, ignoreDuplicates: true }));
    const del = db.from(table).delete().eq('group_id', gid);
    must(await (ids.length ? del.not(col, 'in', `(${ids.join(',')})`) : del));
  };
  const links = (gid: string, g: Awaited<ReturnType<typeof groupInput>>) =>
    Promise.all([link(gid, 'group_members', 'user_id', g.member_ids), link(gid, 'group_scenarios', 'scenario_id', g.scenario_ids)]);
  const groupAudit = (req: FastifyRequest, action: 'group.create' | 'group.update' | 'group.delete', id: string, g: z.infer<typeof S.Group>) =>
    audit(db, req.log, { actor_id: actor(req), action, target: id, meta: { name: g.name, member_count: g.members.length, scenario_count: g.scenarios.length } });

  return {
    'GET /api/admin/users': async () =>
      (must(await db.from('users').select(USER_SELECT).eq('role', 'teacher').order('created_at')) as unknown as UserDbRow[]).map(userRow),

    /** 사용자 추가 = 예비교사 계정 만들기(로그인은 만들지 않는다). 닉네임은 대소문자 무시 유일. */
    'POST /api/admin/users': async (req, reply) => {
      const { nickname, password } = req.body as z.infer<typeof S.Credentials>;
      const r = await db.from('users').insert({ nickname, password_hash: await argon2.hash(password), role: 'teacher' }).select(USER_SELECT).single();
      if (r.error?.code === '23505') throw new ApiFail('nickname_taken', 'nickname is taken');
      const u = userRow(must(r) as unknown as UserDbRow);
      await audit(db, req.log, { actor_id: actor(req), action: 'user.create', target: u.id, meta: { nickname: u.nickname } });
      reply.code(201);
      return u;
    },

    /** 재설정 = 해시 교체 + 그 사용자의 로그인 모두 종료(0002 change_password, 한 트랜잭션). */
    'PUT /api/admin/users/:id/password': async (req, reply) => {
      const id = idParam(req), u = await teacher(id);
      const ok = must(await db.rpc('change_password', {
        p_user_id: id, p_expected_hash: null, p_new_hash: await argon2.hash((req.body as z.infer<typeof S.PasswordReset>).password), p_keep_token_hash: null,
      }));
      if (ok !== true) throw new ApiFail('not_found');   // 그새 삭제됨
      await audit(db, req.log, { actor_id: actor(req), action: 'user.password_reset', target: id, meta: { nickname: u.nickname } });
      reply.code(204).send();
    },

    /** 연습 세션·발화·그룹 구성원·로그인은 FK on delete cascade(USR-1). */
    'DELETE /api/admin/users/:id': async (req, reply) => {
      const id = idParam(req), u = await teacher(id);
      if (!must(await db.from('users').delete().eq('id', id).eq('role', 'teacher').select('id'))?.length) throw new ApiFail('not_found');
      await audit(db, req.log, { actor_id: actor(req), action: 'user.delete', target: id, meta: { nickname: u.nickname, session_count: u.session_count } });
      reply.code(204).send();
    },

    'GET /api/admin/groups': async () =>
      (must(await db.from('groups').select(GROUP_SELECT).order('created_at')) as unknown as GroupDbRow[]).map(groupOut),

    /** 연결이 실패하면 방금 만든 그룹도 지운다. */
    'POST /api/admin/groups': async (req, reply) => {
      const b = await groupInput(req.body as GroupInput);
      const { id } = must(await db.from('groups').insert({ name: b.name }).select('id').single()) as { id: string };
      try { await links(id, b); } catch (err) { await db.from('groups').delete().eq('id', id); throw err; }
      const g = await group(id);
      await groupAudit(req, 'group.create', id, g);
      reply.code(201);
      return g;
    },

    'PUT /api/admin/groups/:id': async req => {
      const id = idParam(req);
      await group(id);
      const b = await groupInput(req.body as GroupInput);
      must(await db.from('groups').update({ name: b.name }).eq('id', id));
      await links(id, b);
      const g = await group(id);
      await groupAudit(req, 'group.update', id, g);
      return g;
    },

    'DELETE /api/admin/groups/:id': async (req, reply) => {
      const id = idParam(req), g = await group(id);
      must(await db.from('groups').delete().eq('id', id));
      await groupAudit(req, 'group.delete', id, g);
      reply.code(204).send();
    },
  };
}
