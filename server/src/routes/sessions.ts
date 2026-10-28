// 예비교사 경로 (C-11, D-14, E-19, E-20, F-22~F-25): 학생 선택·세션 시작/복구/목록/상세·턴 SSE·종료. 세션 경로는 `any` 실, 소유자만.
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import * as S from '@remath/shared';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Deps, Handlers } from '../app.ts';
import { must } from '../db.ts';
import { ApiFail } from '../errors.ts';
import { frame, withTurn } from '../turn.ts';

type Lang = z.infer<typeof S.Lang>;
interface SessionCols {
  id: string; user_id: string; scenario_id: string; lang: Lang; started_at: string; ended_at: string | null; goal_reached: boolean;
  report: z.infer<typeof S.SessionReport> | null; user: { nickname: string };
  scenario: { scenario_translations: { lang: Lang; name: string }[] }; turns: z.infer<typeof S.Turn>[];
}
// scenario_name 은 세션 lang 스냅샷 판(M-9): 두 판 이름을 받아 고른다.
const SESSION = 'id, user_id, scenario_id, lang, started_at, ended_at, goal_reached, report, user:users!inner(nickname), scenario:scenarios!inner(scenario_translations(lang, name))';
const DETAIL = `${SESSION}, turns(seq, speaker, text, leverage, object, trigger, created_at)`;

export function sessionHandlers({ db, config, now }: Deps): Handlers {
  const turnLimit = config.env.MAX_TURNS;
  const turnOpts = { db, maxTurns: turnLimit, timeoutMs: config.env.TURN_TIMEOUT_MS, templates: config.templates, now };

  /** E-19: 목 projection.ts 의 sessionRow 와 같은 모양. turn_count = 예비교사 발화 수. */
  const row = (s: SessionCols): z.infer<typeof S.SessionRow> => ({
    id: s.id, scenario_id: s.scenario_id, scenario_name: s.scenario.scenario_translations.find(t => t.lang === s.lang)?.name ?? '', lang: s.lang,
    user_id: s.user_id, nickname: s.user.nickname, started_at: s.started_at, ended_at: s.ended_at, goal_reached: s.goal_reached,
    turn_count: s.turns.filter(t => t.speaker === 'teacher').length,
  });
  const detail = (s: SessionCols): z.infer<typeof S.SessionDetail> => ({ session: row(s), turns: s.turns, report: s.report, turn_limit: turnLimit });
  const mine = (req: FastifyRequest, cols: string) => db.from('sessions').select(cols).eq('user_id', req.auth!.user.id);
  /** 남의 세션·없는 세션·uuid 가 아닌 id 는 모두 404(C-10, 목 sessionOf). */
  const load = async (q: ReturnType<typeof mine>) => must(await q.order('seq', { referencedTable: 'turns' }).maybeSingle()) as unknown as SessionCols | null;
  const sessionOf = async (req: FastifyRequest, light?: 'light'): Promise<SessionCols> => {
    const { id } = req.params as { id: string };
    const q = S.Uuid.safeParse(id).success ? mine(req, light ? 'id, ended_at' : DETAIL).eq('id', id) : null;
    const s = !q ? null : light ? must(await q.maybeSingle()) as unknown as SessionCols | null : await load(q);
    if (!s) throw new ApiFail('not_found', 'session not found');
    return s;
  };

  return {
    /** C-11·E-20: 시나리오는 teacher_scenarios 결과만, group_ids 는 group_members ⋈ group_scenarios 에서 따로. scenarios 원본은 읽지 않는다. */
    'GET /api/practice': async req => {
      const uid = req.auth!.user.id;
      const [scenarios, groups] = await Promise.all([
        db.rpc('teacher_scenarios', { p_user_id: uid }).then(must) as Promise<{ id: string }[]>,
        db.from('groups').select('id, name, group_members!inner(user_id), group_scenarios(scenario_id)')
          .eq('group_members.user_id', uid).order('created_at').then(must) as Promise<{ id: string; name: string; group_scenarios: { scenario_id: string }[] }[]>,
      ]);
      return {
        groups: groups.map(g => ({ id: g.id, name: g.name })),
        scenarios: scenarios.map(s => ({ ...s, group_ids: groups.filter(g => g.group_scenarios.some(x => x.scenario_id === s.id)).map(g => g.id) })),
      };
    },
    /** 내 기록, 최신순(M-13: 예비교사 쿠키만). */
    'GET /api/sessions': async req =>
      (must(await mine(req, `${SESSION}, turns(speaker)`).order('started_at', { ascending: false })) as unknown as SessionCols[]).map(row),
    'GET /api/sessions/current': async req => {
      const s = await load(mine(req, DETAIL).is('ended_at', null));
      return s ? detail(s) : null;
    },
    'GET /api/sessions/:id': async req => detail(await sessionOf(req)),

    /**
     * 예비교사는 teacher_scenarios 에 있는 시나리오만(아니면 403, 없는 id 도 403 — 원본을 읽기 전에 거른다), 관리자는 원본으로 초안도(없으면 404).
     * 진행 중 세션은 sessions_one_active 부분 unique 가 하나만 허락한다(D-14): 위반 = 409 session_active.
     */
    'POST /api/sessions': async (req, reply) => {
      const { scenario_id } = req.body as z.infer<typeof S.StartSession>, u = req.auth!.user;
      if (u.role === 'teacher' && !(must(await db.rpc('teacher_scenarios', { p_user_id: u.id }).eq('id', scenario_id)) as unknown[]).length) throw new ApiFail('forbidden', 'scenario is not assigned to you');
      // 접근 확인 뒤 턴 파이프라인의 몫(오개념 카운터 초기값·인사 발화)만 원본에서 읽는다(ADR-0003 4항).
      const sc = must(await db.from('scenarios').select('lang, internal, scenario_translations(lang, greet)').eq('id', scenario_id).maybeSingle()) as
        { lang: Lang; internal: { misconceptions?: unknown[] }; scenario_translations: { lang: Lang; greet: string }[] } | null;
      if (!sc) throw new ApiFail('not_found', 'scenario not found');
      // 세션 행과 인사 발화(seq 1)는 rpc 한 번(0003 start_session, 한 트랜잭션): 복구·턴이 인사 없는 세션을 보지 못한다.
      const r = await db.rpc('start_session', {
        p_user_id: u.id, p_scenario_id: scenario_id, p_lang: sc.lang, p_progress: { mis: (sc.internal.misconceptions ?? []).map(() => 0) }, p_counts: {},
        p_greet: sc.scenario_translations.find(t => t.lang === sc.lang)?.greet ?? '',
      });
      if (r.error?.code === '23505') {
        const active = must(await db.from('sessions').select('id').eq('user_id', u.id).is('ended_at', null).maybeSingle()) as { id: string } | null;
        throw new ApiFail('session_active', 'a session is in progress', { session_id: active?.id });
      }
      const id = must(r) as string;
      reply.code(201);
      return detail((await load(mine(req, DETAIL).eq('id', id)))!);
    },

    /**
     * F-22~F-24: 검사(409·422)는 일반 오류 응답, 통과하면 text/event-stream. 끊김 감지는 첫 await(소유자 읽기) 전에 건다:
     * 끊기면 abort → 아직 안 잡았으면 잡지 않고, 잡았으면 발화 미기록 + 턴 해제(withTurn 의 finally). 스트림이 다 끝나야 withTurn 이 돌아온다.
     */
    'POST /api/sessions/:id/turns': async (req, reply) => {
      const ac = new AbortController();
      // request.raw 의 close 는 본문을 다 읽으면 바로 온다(Node 16+). 끊김은 응답 소켓 쪽에서 본다. preValidation 중에 이미 끊겼을 수도 있다.
      reply.raw.on('close', () => { if (!reply.raw.writableFinished) ac.abort(); });
      if (reply.raw.destroyed || req.raw.socket?.destroyed) ac.abort();
      const { text } = req.body as z.infer<typeof S.TurnBody>;
      return withTurn({ ...turnOpts, log: req.log, signal: ac.signal }, await sessionOf(req, 'light'), text, async events => {
        const body = Readable.from((async function* () { for await (const ev of events) yield frame(ev); })());
        ac.signal.addEventListener('abort', () => body.destroy(), { once: true });
        reply.header('content-type', 'text/event-stream; charset=utf-8').header('cache-control', 'no-cache').send(body);
        await finished(body).catch(() => {});   // 끝까지 보냈거나, 끊겨 생성기 return() 까지 끝났을 때
        return reply;
      });
    },
    /** F-25: 종료 버튼 = END SESSION 발화와 같은 함수·같은 SessionReport|null. 재열람은 sessions.report 저장본. */
    'POST /api/sessions/:id/end': async req => {
      return withTurn({ ...turnOpts, log: req.log }, await sessionOf(req, 'light'), 'END SESSION', async events => {
        for await (const ev of events) {
          if (ev.type === 'error') throw new ApiFail('provider_unavailable', ev.message);
          if (ev.type === 'done' && ev.ended) return ev.report;
        }
        // 결과를 모른다(이벤트 없이 끝남): 리포트를 지어내지 않는다. 화면의 end() 는 오류를 보이고 finally 에서 GET 으로 맞춘다.
        throw new ApiFail('provider_unavailable', 'turn outcome unknown: reload');
      });
    },
  };
}
