// A-2 (practice-session rules), A-3 (L1·L2 replays through sendTurn), A-6 (admin `state`).
// HTTP groups run on any target (seam.ts); the [mock] group reloads the store and injects turnLimit.
import * as S from '@remath/shared';
import { HELP_LINE, TXT } from '@remath/shared/engine';
import gabriel from '@remath/seed/scenarios/gabriel.json';
import { describe, expect, it } from 'vitest';
import { ApiError, type AdminApi, type AdminSseEvent, type Api } from '../types.ts';
import { ADMIN_PW, describeMock, mockTarget, T0, target, type Target } from '../seam.ts';
import { createMockApi } from './index.ts';
import { memoryStorage, seedDb, Store } from './store.ts';

async function setup(t: Target = target()) {
  const admin = t.api('admin') as unknown as AdminApi;
  const teacher = t.api('teacher');
  await admin.adminLogin({ nickname: 'admin', password: ADMIN_PW });
  const ids = Object.fromEntries((await admin.listScenarios()).map(s => [s.slug, s.id]));
  return { t, admin, teacher, ids };
}

/** A teacher who can see `slug` through a group. */
async function teacherWith(env: Awaited<ReturnType<typeof setup>>, slug: string, nickname = 'Haneul') {
  const me = await env.teacher.signup({ nickname, password: 'abcd1234' });
  await env.admin.createGroup({ name: 'g', member_ids: [me.id], scenario_ids: [env.ids[slug]] });
  return me;
}

async function rejects(p: Promise<unknown>, status: number, code: string): Promise<ApiError> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect([(e as ApiError).status, (e as ApiError).code]).toEqual([status, code]);
    return e as ApiError;
  }
  throw new Error(`expected ${status} ${code}`);
}
const drain = async <E>(it: AsyncIterable<E>) => { const out: E[] = []; for await (const e of it) out.push(e); return out; };
const firstNext = (it: AsyncIterable<unknown>) => it[Symbol.asyncIterator]().next();

describe('A-2 practice-session rules', () => {
  it('startSession: greeting is seq 1 from the student; turn_limit defaults to 40', async () => {
    const env = await setup();
    const d = await env.admin.startSession({ scenario_id: env.ids.gabriel });
    expect(S.SessionDetail.parse(d)).toBeTruthy();
    expect(d.turns.map(t => [t.seq, t.speaker, t.text])).toEqual([[1, 'student', gabriel.translations.ko.greet]]);
    expect([d.turn_limit, d.session.turn_count, d.session.ended_at, d.report]).toEqual([40, 0, null, null]);
  });
  it('one in-progress session per user: 409 session_active + details.session_id; getCurrentSession recovers it', async () => {
    const env = await setup();
    expect(await env.admin.getCurrentSession()).toBeNull();
    const d = await env.admin.startSession({ scenario_id: env.ids.gabriel });
    const e = await rejects(env.admin.startSession({ scenario_id: env.ids.noah }), 409, 'session_active');
    expect(e.body.error.details).toEqual({ session_id: d.session.id });
    expect(await env.admin.getCurrentSession()).toEqual(d);
    expect(await env.admin.getSession(d.session.id)).toEqual(d);
  });
  it('teachers start only published scenarios assigned to their groups (403); admins may test a draft', async () => {
    const env = await setup();
    await teacherWith(env, 'gabriel');
    await rejects(env.teacher.startSession({ scenario_id: env.ids.noah }), 403, 'forbidden');
    await env.admin.updateScenario(env.ids.gabriel, S.ScenarioInput.parse(await env.admin.getScenario(env.ids.gabriel)));   // PUT → draft
    await rejects(env.teacher.startSession({ scenario_id: env.ids.gabriel }), 403, 'forbidden');
    expect((await env.admin.startSession({ scenario_id: env.ids.gabriel })).turns).toHaveLength(1);
    await rejects(env.admin.startSession({ scenario_id: '00000000-0000-4000-8000-0000000000ff' }), 404, 'not_found');
  });
  it('teachers: picking another student while a session is in progress → 409 session_active + details.session_id', async () => {
    const env = await setup(), me = await teacherWith(env, 'gabriel');
    await env.admin.createGroup({ name: 'h', member_ids: [me.id], scenario_ids: [env.ids.noah] });
    const d = await env.teacher.startSession({ scenario_id: env.ids.gabriel });
    const e = await rejects(env.teacher.startSession({ scenario_id: env.ids.noah }), 409, 'session_active');
    expect(e.body.error.details).toEqual({ session_id: d.session.id });
    await env.teacher.endSession(d.session.id);
    expect((await env.teacher.startSession({ scenario_id: env.ids.noah })).session.scenario_id).toBe(env.ids.noah);
  });
  it("another user's session is 404 to getSession", async () => {
    const env = await setup();
    await teacherWith(env, 'gabriel');
    const d = await env.admin.startSession({ scenario_id: env.ids.gabriel });
    await rejects(env.teacher.getSession(d.session.id), 404, 'not_found');
    expect(await env.teacher.getCurrentSession()).toBeNull();
  });
});

type Ev = AdminSseEvent;
/** Send each question through sendTurn; returns the events per turn (every event must parse as the realm's union). */
async function replay(api: Api | AdminApi, sid: string, qs: string[], schema: typeof S.SseEvent | typeof S.AdminSseEvent = S.SseEvent) {
  const log: Ev[][] = [];
  for (const q of qs) {
    const evs = await drain<Ev>(api.sendTurn(sid, { text: q }));
    for (const e of evs) expect(schema.safeParse(e).success, JSON.stringify(e)).toBe(true);
    log.push(evs);
  }
  return log;
}
const pick = <K extends Ev['type']>(evs: Ev[], type: K) => evs.find(e => e.type === type) as Extract<Ev, { type: K }> | undefined;
const student = (evs: Ev[]) => pick(evs, 'student')?.text;
const trigger = (evs: Ev[]) => pick(evs, 'trigger')?.trigger;
const L1 = ['안녕, 네 이름이 뭐야?', '어떻게 풀었는지 말해 줄래?', '한 친구가 받는 걸 모두 합치면 얼마야?', '그러면 한 사람이 받는 게 전부 얼마인지 하나로 말해 볼래?', '4분의 1 조각을 반으로 자르면 어떻게 될까?', '그 조각을 더 작게 자르면 8분의 1이 몇 개야?', '8분의 1 조각이 다 해서 몇 개야?', '모두 몇 조각인지 세어 볼래?'];
const L2 = ['안녕!', '통분하면 돼. 분모를 같게 만들어 봐.', '2/4는 4/8이니까 더하면 5/8이야. 답은 5/8이야.', '그림을 어떻게 그렸어?'];

describe('A-3 turn pipeline through sendTurn', () => {
  it('L1 · Gabriel reaches the goal (ko): lines, trigger 3 + t3, leverage column, clean/reached report', async () => {
    const env = await setup(), ko = gabriel.translations.ko, m = ko.misconceptions;
    await teacherWith(env, 'gabriel');
    const sid = (await env.teacher.startSession({ scenario_id: env.ids.gabriel })).session.id;
    const log = await replay(env.teacher, sid, L1);
    expect(log.map(student)).toEqual(['안녕하세요… 저는 가브리엘이에요.', ko.elicit[0], m[0].h, m[0].c, m[1].h, m[1].c, m[2].h, `${m[2].c}\n${ko.aha}`]);
    expect(log.map(trigger)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined, 3]);
    expect(pick(log[7], 'mentor')?.text).toBe(ko.t3);
    expect(log.map(evs => evs.map(e => e.type))[7]).toEqual(['classification', 'student', 'trigger', 'mentor', 'done']);
    // done carries this turn's rows with seq: teacher → student → mentor (trigger only on the mentor row)
    const done = pick(log[7], 'done') as Extract<Ev, { type: 'done'; ended: false }>;
    expect(done.turns.map(t => [t.seq, t.speaker, t.leverage, t.trigger])).toEqual([[16, 'teacher', 'Eliciting', null], [17, 'student', null, null], [18, 'mentor', null, 3]]);

    const d = await env.teacher.getSession(sid);
    expect(d.turns.filter(t => t.speaker === 'teacher').map(t => t.leverage)).toEqual(['Other', 'Eliciting', 'Eliciting', 'Eliciting', 'Extending', 'Extending', 'Eliciting', 'Eliciting']);
    expect([d.session.turn_count, d.session.goal_reached]).toEqual([8, true]);
    expect(d.turns.some(t => /^(Mentor|멘토|Student|학생|Teacher|예비교사):/.test(t.text))).toBe(false);

    const [end] = await replay(env.teacher, sid, ['END SESSION']);
    expect(end.map(e => e.type)).toEqual(['done']);
    const report = (end[0] as Extract<Ev, { type: 'done'; ended: true }>).report!;
    expect([report.total, report.reached, report.verdict, report.summary]).toEqual([8, true, 'clean', `${TXT.ko.clean(5, 2)}\n${TXT.ko.endReached}`]);
    expect(report.rows.map(r => [r.name, r.count, r.turns.map(t => t.seq)])).toEqual([['Eliciting', 5, [4, 6, 8, 14, 16]], ['Extending', 2, [10, 12]], ['Taking Over', 0, []], ['Other', 1, [2]]]);
    expect(report.rows[0].desc).toBe(gabriel.classification.leverage[0].desc);
    const after = await env.teacher.getSession(sid);
    expect([after.report, after.session.turn_count, after.turns.length]).toEqual([report, 8, 18]);   // greeting + 8×(teacher, student) + 1 mentor; END SESSION itself is not recorded
    expect(after.session.ended_at).not.toBeNull();
  });
  it('L2 · Taking Over twice (ko): confused[0]·[1] + trigger 1 + t1, heavy', async () => {
    const env = await setup(), ko = gabriel.translations.ko;
    const sid = (await env.admin.startSession({ scenario_id: env.ids.gabriel })).session.id;
    const log = await replay(env.admin, sid, L2, S.AdminSseEvent);
    expect(log.slice(1).map(student)).toEqual([ko.confused[0], ko.confused[1], ko.elicit[0]]);
    expect(log.slice(1).map(trigger)).toEqual([1, 1, undefined]);
    expect(pick(log[1], 'mentor')?.text).toBe(ko.t1);
    const report = await env.admin.endSession(sid);
    expect([report?.verdict, report?.reached, report?.summary]).toEqual(['heavy', false, `${TXT.ko.heavy(2, 1)}\n${TXT.ko.endNot}`]);
  });
  it('help request (en): fixed line, trigger 2, helpLead frames', async () => {
    const env = await setup(), noah = (await env.admin.getScenario(env.ids.noah)).translations.en;
    const sid = (await env.admin.startSession({ scenario_id: env.ids.noah })).session.id;
    const [evs] = await replay(env.admin, sid, ['Help'], S.AdminSseEvent);
    expect(student(evs)).toBe(HELP_LINE.en);
    expect(trigger(evs)).toBe(2);
    expect(pick(evs, 'mentor')?.text).toBe(`${TXT.en.helpLead}\n${noah.t2.split('\n').filter(Boolean).map(x => '· ' + x).join('\n')}`);
  });
  it('no criteria (hajun): no classification event, leverage null, report null', async () => {
    const env = await setup();
    const sid = (await env.admin.startSession({ scenario_id: env.ids.hajun })).session.id;
    const [evs] = await replay(env.admin, sid, ['어떻게 풀었는지 말해 줄래?'], S.AdminSseEvent);
    expect(pick(evs, 'classification')).toBeUndefined();
    expect((pick(evs, 'done') as Extract<Ev, { type: 'done'; ended: false }>).turns[0].leverage).toBeNull();
    expect(await env.admin.endSession(sid)).toBeNull();
    expect((await env.admin.getSession(sid)).report).toBeNull();
  });
  it('after the goal: no directive or trigger, only the leverage count rises', async () => {
    const env = await setup();
    const sid = (await env.admin.startSession({ scenario_id: env.ids.gabriel })).session.id;
    await replay(env.admin, sid, L1, S.AdminSseEvent);
    const [evs] = await replay(env.admin, sid, ['통분하면 돼. 답은 5/8이야.'], S.AdminSseEvent);
    expect(trigger(evs)).toBeUndefined();
    expect(TXT.ko.reached).toContain(student(evs));
    const st = pick(evs, 'state')!;
    expect([st.counts['Taking Over'], st.goal_reached, st.last_trigger]).toEqual([1, true, 3]);
  });
});

describe('A-2 turn rules', () => {
  it('END SESSION and endSession give the same report, stored once; the session is then 409 session_ended', async () => {
    const env = await setup(), report = async (how: 'turn' | 'end') => {
      const sid = (await env.admin.startSession({ scenario_id: env.ids.gabriel })).session.id;
      await replay(env.admin, sid, L2, S.AdminSseEvent);
      const r = how === 'end' ? await env.admin.endSession(sid) : ((await drain(env.admin.sendTurn(sid, { text: 'END SESSION' }))).at(-1) as Extract<Ev, { type: 'done'; ended: true }>).report;
      expect((await env.admin.getSession(sid)).report).toEqual(r);
      await rejects(firstNext(env.admin.sendTurn(sid, { text: '왜?' })), 409, 'session_ended');
      await rejects(env.admin.endSession(sid), 409, 'session_ended');
      expect((await env.admin.getSession(sid)).report).toEqual(r);
      return r;
    };
    const a = await report('turn'), b = await report('end');
    expect(a).toEqual(b);
    expect(a?.verdict).toBe('heavy');
  });
});

// Mock-only: the mock runs a turn as the client pulls; over HTTP the server records it before the first byte arrives (#46).
// The server's drop behaviour is covered by server/src/turn.test.ts dropDuring and the #46 live abort check.
describeMock('A-2 turn rules: mid-stream', () => {
  it('409 turn_in_progress while a turn streams; finally releases it', async () => {
    const env = await setup();
    const sid = (await env.admin.startSession({ scenario_id: env.ids.gabriel })).session.id;
    const it1 = env.admin.sendTurn(sid, { text: '어떻게 풀었는지 말해 줄래?' })[Symbol.asyncIterator]();
    await it1.next();   // the stream has started
    const e = await rejects(firstNext(env.admin.sendTurn(sid, { text: '왜?' })), 409, 'turn_in_progress');
    expect(e.body.error.details).toEqual({ turn_started_at: expect.any(String) });
    S.Iso.parse((e.body.error.details as { turn_started_at: unknown }).turn_started_at);
    await rejects(env.admin.endSession(sid), 409, 'turn_in_progress');
    await it1.return?.(undefined);   // client went away mid-stream: nothing recorded, lock released
    expect((await env.admin.getSession(sid)).turns).toHaveLength(1);
    expect((await drain(env.admin.sendTurn(sid, { text: '왜?' }))).at(-1)?.type).toBe('done');
  });
});

describeMock('A-2 turn rules: reload, turnLimit', () => {
  it('a reload mid-turn leaves no stuck turn_started_at: the reloaded store can send and end', async () => {
    const storage = memoryStorage();
    const env = await setup(mockTarget({ store: new Store(storage, () => seedDb(T0)) }));
    const sid = (await env.admin.startSession({ scenario_id: env.ids.gabriel })).session.id;
    await env.admin.sendTurn(sid, { text: '어떻게 풀었는지 말해 줄래?' })[Symbol.asyncIterator]().next();   // tab closes mid-stream
    expect((await rejects(firstNext(env.admin.sendTurn(sid, { text: '왜?' })), 409, 'turn_in_progress')).body.error.details).toEqual({ turn_started_at: T0 });
    const admin2 = createMockApi({ realm: 'admin', store: new Store(storage, () => seedDb(T0)), now: () => T0, adminPassword: ADMIN_PW }) as unknown as AdminApi;
    expect((await drain(admin2.sendTurn(sid, { text: '왜?' }))).at(-1)?.type).toBe('done');
    expect(await admin2.endSession(sid)).not.toBeUndefined();
  });
  it('422 turn_limit_reached + details at the limit; END SESSION still ends the session', async () => {
    const env = await setup(mockTarget({ turnLimit: 2 }));
    const d = await env.admin.startSession({ scenario_id: env.ids.gabriel });
    expect(d.turn_limit).toBe(2);
    await replay(env.admin, d.session.id, ['안녕!', '왜?'], S.AdminSseEvent);
    const e = await rejects(firstNext(env.admin.sendTurn(d.session.id, { text: '어떻게?' })), 422, 'turn_limit_reached');
    expect(e.body.error.details).toEqual({ turn_count: 2, turn_limit: 2 });
    const [end] = await replay(env.admin, d.session.id, ['end session'], S.AdminSseEvent);
    expect(end.at(-1)).toMatchObject({ type: 'done', ended: true });
    expect((await env.admin.getSession(d.session.id)).session.turn_count).toBe(2);
  });
});

describe('A-6 admin state', () => {
  it('admin sessions get one `state` right before done (both ended branches); getAdminSession = AdminSessionDetail', async () => {
    const env = await setup();
    const sid = (await env.admin.startSession({ scenario_id: env.ids.gabriel })).session.id;
    const log = await replay(env.admin, sid, [...L2.slice(0, 2), 'END SESSION'], S.AdminSseEvent);
    for (const evs of log) expect(evs.slice(-2).map(e => e.type)).toEqual(['state', 'done']);
    expect(log.map(evs => evs.filter(e => e.type === 'state').length)).toEqual([1, 1, 1]);
    const st = pick(log[1], 'state')!;
    expect(st).toEqual({ type: 'state', mis: [0, 0, 0], counts: { Other: 1, 'Taking Over': 1 }, goal_reached: false, last_trigger: 1 });
    expect(S.SseEvent.safeParse(st).success).toBe(false);   // the teacher union rejects it

    const d = await env.admin.getAdminSession(sid);
    expect(S.AdminSessionDetail.strict().parse(d)).toEqual(d);
    const { type: _, ...state } = pick(log[2], 'state')!;
    expect(d.state).toEqual(state);
    expect(d.session.ended_at).not.toBeNull();
  });
  it('teacher sessions never get `state`; getAdminSession of a teacher session works for the admin', async () => {
    const env = await setup();
    await teacherWith(env, 'gabriel');
    const sid = (await env.teacher.startSession({ scenario_id: env.ids.gabriel })).session.id;
    const log = await replay(env.teacher, sid, [...L1.slice(0, 2), 'END SESSION']);   // replay parses every event with S.SseEvent
    expect(log.flat().some(e => e.type === 'state')).toBe(false);
    expect((await env.admin.getAdminSession(sid)).state).toEqual({ mis: [0, 0, 0], counts: { Other: 1, Eliciting: 1 }, goal_reached: false, last_trigger: null });
    const otherBrowser = env.t.browser()('teacher');
    await rejects(otherBrowser.getAdminSession(sid), 401, 'unauthorized');
  });
});
