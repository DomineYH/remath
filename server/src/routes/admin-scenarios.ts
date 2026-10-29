// 관리자 — 시나리오 (E-21, G-27): 목록·상세·초안 저장·삭제·검수·게시·컴파일 전문. 목 scenarios.ts 와 같은 규칙.
import { randomUUID } from 'node:crypto';
import { checkTemplates, compileScenario } from '@remath/prompts';
import * as S from '@remath/shared';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Deps, Handlers } from '../app.ts';
import { audit } from '../audit.ts';
import { must, readAll } from '../db.ts';
import { ApiFail } from '../errors.ts';
import { SCENARIO_SELECT, toAdmin, toInput, toSummary, type ScenarioDbRow } from '../projection.ts';

type Input = z.infer<typeof S.ScenarioInput>;

/** `:id` 가 uuid 가 아니면 PostgREST 가 22P02 로 500 을 낸다: 없는 행과 같은 404. */
export const idParam = (req: FastifyRequest) => {
  const { id } = req.params as { id: string };
  if (!S.Uuid.safeParse(id).success) throw new ApiFail('not_found');
  return id;
};

export function adminScenarioHandlers({ db, config }: Deps): Handlers {
  const templatesOk = checkTemplates(config.templates).every(t => t.ok);
  const compile = (i: Input) => compileScenario(i, i.translations[i.lang], i.lang, config.templates);
  const load = async (id: string) => {
    const s = must(await db.from('scenarios').select(SCENARIO_SELECT).eq('id', id).maybeSingle()) as ScenarioDbRow | null;
    if (!s) throw new ApiFail('not_found');
    return s;
  };
  /** 시나리오 행(draft + compiled_prompt null) + 번역 2행을 한 트랜잭션으로(0004). slug 가 있으면 생성. */
  const save = async (id: string, slug: string | null, b: Input) =>
    must(await db.rpc('save_scenario', { p_id: id, p_slug: slug, p_input: b })) === true;
  const actor = (req: FastifyRequest) => req.auth!.user.id;

  return {
    'GET /api/admin/scenarios': async () =>
      (await readAll<ScenarioDbRow>(() => db.from('scenarios').select(SCENARIO_SELECT).order('updated_at', { ascending: false }).order('id'))).map(toSummary),

    /** 새 시나리오는 초안, slug 는 서버가 만든다. */
    'POST /api/admin/scenarios': async (req, reply) => {
      const id = randomUUID(), slug = `scenario-${id.slice(0, 8)}`;
      await save(id, slug, req.body as Input);
      await audit(db, req.log, { actor_id: actor(req), action: 'scenario.create', target: id, meta: { slug } });
      reply.code(201);
      return toAdmin(await load(id));
    },

    'GET /api/admin/scenarios/:id': async req => toAdmin(await load(idParam(req))),

    /** 초안 저장 = 항상 draft + compiled_prompt null(게시본은 내려간다). updated_at 이 옮겨져 진행 중인 게시를 무효로 한다. */
    'PUT /api/admin/scenarios/:id': async req => {
      const id = idParam(req), s = await load(id);
      if (!(await save(id, null, req.body as Input))) throw new ApiFail('not_found');
      await audit(db, req.log, { actor_id: actor(req), action: 'scenario.update', target: id, meta: { slug: s.slug } });
      return toAdmin(await load(id));
    },

    /** 기록이 있으면 409 + 건수. 번역·그룹 할당은 FK cascade, 그새 시작된 세션은 on delete restrict(23503)가 막는다. */
    'DELETE /api/admin/scenarios/:id': async (req, reply) => {
      const id = idParam(req), s = await load(id);
      const has = (x: ScenarioDbRow) => new ApiFail('scenario_has_sessions', 'scenario has sessions', { session_count: toAdmin(x).session_count });
      if (toAdmin(s).session_count) throw has(s);
      const r = await db.from('scenarios').delete().eq('id', id);
      if (r.error?.code === '23503') throw has(await load(id));
      must(r);
      await audit(db, req.log, { actor_id: actor(req), action: 'scenario.delete', target: id, meta: { slug: s.slug } });
      reply.code(204).send();
    },

    'GET /api/admin/scenarios/:id/review': async req => S.autoChecks(toInput(await load(idParam(req))), templatesOk),

    /**
     * 자동 점검 fail 이 있거나 확인 m1~m4 가 다 없으면 422(details = ReviewResult). 통과하면 검수한 그 판의 컴파일본으로 게시하되,
     * 읽은 뒤 저장이 끼어들었으면(updated_at 이 다름, 0004 publish_scenario) 게시하지 않고 지금 판의 검수 결과로 422.
     * 409 코드들(session_active 등)은 화면에 엉뚱한 문구를 띄우므로 review_failed 를 쓴다.
     */
    'POST /api/admin/scenarios/:id/publish': async req => {
      const id = idParam(req), s = await load(id), input = toInput(s), r = S.autoChecks(input, templatesOk);
      if (!r.publishable || new Set((req.body as z.infer<typeof S.PublishBody>).confirmed).size < 4) throw new ApiFail('review_failed', 'review failed', r);
      const ok = must(await db.rpc('publish_scenario', { p_id: id, p_expected_updated_at: s.updated_at, p_compiled: compile(input) }));
      if (ok !== true) throw new ApiFail('review_failed', 'scenario changed since review', S.autoChecks(toInput(await load(id)), templatesOk));
      await audit(db, req.log, { actor_id: actor(req), action: 'scenario.publish', target: id, meta: { slug: s.slug, lang: s.lang } });
      return toAdmin(await load(id));
    },

    /** 저장된 컴파일본(게시본), 없으면(초안) 그 자리에서 활성 언어판으로 컴파일. */
    'GET /api/admin/scenarios/:id/prompt': async req => { const s = await load(idParam(req)); return s.compiled_prompt ?? compile(toInput(s)); },
  };
}
