// 관리자 — 시나리오 (E-21, G-27): 목록·상세·초안 저장·삭제·검수·게시·컴파일 전문. 목 scenarios.ts 와 같은 규칙.
import { randomUUID } from 'node:crypto';
import { checkTemplates, compileScenario } from '@remath/prompts';
import * as S from '@remath/shared';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Deps, Handlers } from '../app.ts';
import { audit } from '../audit.ts';
import { must } from '../db.ts';
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
  const split = ({ translations, ...cols }: Input, id: string) =>
    ({ cols, tr: (['ko', 'en'] as const).map(lang => ({ scenario_id: id, lang, ...translations[lang] })) });
  const actor = (req: FastifyRequest) => req.auth!.user.id;

  return {
    'GET /api/admin/scenarios': async () =>
      (must(await db.from('scenarios').select(SCENARIO_SELECT).order('updated_at', { ascending: false })) as unknown as ScenarioDbRow[]).map(toSummary),

    /** 새 시나리오는 초안, slug 는 서버가 만든다. 번역 2행이 실패하면 시나리오 행도 지운다(Data API 는 트랜잭션이 없다). */
    'POST /api/admin/scenarios': async (req, reply) => {
      const id = randomUUID(), slug = `scenario-${id.slice(0, 8)}`, { cols, tr } = split(req.body as Input, id);
      must(await db.from('scenarios').insert({ id, slug, status: 'draft', compiled_prompt: null, ...cols }));
      const r = await db.from('scenario_translations').insert(tr);
      if (r.error) { await db.from('scenarios').delete().eq('id', id); throw r.error; }
      await audit(db, req.log, { actor_id: actor(req), action: 'scenario.create', target: id, meta: { slug } });
      reply.code(201);
      return toAdmin(await load(id));
    },

    'GET /api/admin/scenarios/:id': async req => toAdmin(await load(idParam(req))),

    /**
     * 초안 저장 = 항상 draft + compiled_prompt null(게시본은 내려간다). 시나리오 행을 먼저 내려서,
     * 번역 upsert 가 실패해도 게시본이 새 번역과 어긋난 채 남지 않는다.
     */
    'PUT /api/admin/scenarios/:id': async req => {
      const id = idParam(req), s = await load(id), { cols, tr } = split(req.body as Input, id);
      must(await db.from('scenarios').update({ ...cols, status: 'draft', compiled_prompt: null }).eq('id', id));
      must(await db.from('scenario_translations').upsert(tr, { onConflict: 'scenario_id,lang' }));
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

    /** 자동 점검 fail 이 있거나 확인 m1~m4 가 다 없으면 422(details = ReviewResult). 통과하면 컴파일본을 저장하고 게시. */
    'POST /api/admin/scenarios/:id/publish': async req => {
      const id = idParam(req), s = await load(id), input = toInput(s), r = S.autoChecks(input, templatesOk);
      if (!r.publishable || new Set((req.body as z.infer<typeof S.PublishBody>).confirmed).size < 4) throw new ApiFail('review_failed', 'review failed', r);
      // ponytail: 읽기와 쓰기 사이의 동시 초안 저장은 막지 않는다(관리자 1명). 필요해지면 updated_at 조건부 update.
      must(await db.from('scenarios').update({ status: 'published', compiled_prompt: compile(input) }).eq('id', id));
      await audit(db, req.log, { actor_id: actor(req), action: 'scenario.publish', target: id, meta: { slug: s.slug, lang: s.lang } });
      return toAdmin(await load(id));
    },

    /** 저장된 컴파일본(게시본), 없으면(초안) 그 자리에서 활성 언어판으로 컴파일. */
    'GET /api/admin/scenarios/:id/prompt': async req => { const s = await load(idParam(req)); return s.compiled_prompt ?? compile(toInput(s)); },
  };
}
