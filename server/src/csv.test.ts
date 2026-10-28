/// <reference types="vite/client" />   // 목의 import.meta.env 를 서버 tsc 가 검사한다
// T-1 (c): 같은 행을 목과 서버에 넣고 결과만 비교한다(목 csv()·adminState·sessionRow 를 shared 로 올리지 않는다).
import { describe, expect, it } from 'vitest';
import { ADMIN_PW, mockTarget } from '../../client/src/api/seam.ts';
import type { AdminApi, Api } from '../../client/src/api/types.ts';
import { csv } from './csv.ts';
import { sessionRow, type SessionDbRow } from './projection.ts';
import { adminState } from './turn.ts';

const drain = async <E>(it: AsyncIterable<E>) => { const out: E[] = []; for await (const e of it) out.push(e); return out; };
const say = (t: Api, sid: string, text: string) => drain(t.sendTurn(sid, { text }));
const tick = (() => { let n = 0; return () => new Date(Date.parse('2026-10-28T00:00:00.000Z') + 1000 * n++).toISOString(); })();

/** 목 저장소에 세션 2개(따옴표·쉼표·줄바꿈 발화, 분류 없는 학생·멘토 행, 다른 lang 판)를 만든다. */
async function mockWithSessions() {
  const m = mockTarget({ now: tick }), admin = m.api('admin'), t = m.browser()('teacher');
  await admin.adminLogin({ nickname: 'admin', password: ADMIN_PW });
  const ids = Object.fromEntries((await admin.listScenarios()).map(s => [s.slug, s.id]));
  const me = await t.signup({ nickname: 'Haneul', password: 'abcd1234' });
  await admin.createGroup({ name: 'A', member_ids: [me.id], scenario_ids: [ids.gabriel, ids.noah] });
  const s1 = await t.startSession({ scenario_id: ids.gabriel });
  await say(t, s1.session.id, '왜 그렇게 생각했어, "정말"?\n둘째 줄');
  await say(t, s1.session.id, '그럼 다시,\r\n해 볼까?');
  await t.endSession(s1.session.id);
  const noah = m.store.db.scenarios.find(s => s.id === ids.noah)!;
  noah.lang = 'en';   // noah 는 en 판으로 시작한 세션
  const s2 = await t.startSession({ scenario_id: ids.noah });
  await say(t, s2.session.id, 'Why "half"?');
  noah.lang = 'ko';   // 활성 판이 바뀌어도 세션 lang 판 이름(M-9)
  return { m, admin, sids: [s1.session.id, s2.session.id] };
}

/** 목 저장소 행 → Data API 가 SESSION_DETAIL_SELECT 로 주는 모양. */
function asDbRows(db: ReturnType<typeof mockTarget>['store']['db']): SessionDbRow[] {
  return [...db.sessions].sort((a, b) => b.started_at.localeCompare(a.started_at)).map(s => ({
    id: s.id, user_id: s.user_id, scenario_id: s.scenario_id, lang: s.lang, started_at: s.started_at, ended_at: s.ended_at,
    goal_reached: s.goal_reached, report: s.report, progress: s.progress, counts: s.counts,
    user: { nickname: db.users.find(u => u.id === s.user_id)!.nickname },
    scenario: { scenario_translations: (['ko', 'en'] as const).map(lang => ({ lang, name: db.scenarios.find(x => x.id === s.scenario_id)!.translations[lang].name })) },
    turns: db.turns.filter(x => x.session_id === s.id).sort((a, b) => a.seq - b.seq).map(({ session_id: _, ...x }) => x),
  }));
}
async function* pages(rows: SessionDbRow[], size: number) { for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size); }
const bytes = async (chunks: AsyncIterable<string>) => new Uint8Array(Buffer.from((await drain(chunks)).join(''), 'utf8'));

describe('CSV generator = mock csv() byte for byte (T-1 c, G-26)', () => {
  it('same sessions → same bytes: BOM, C13 header, every cell quoted, "" escapes, CRLF, newest session first, seq order', async () => {
    const { m, admin } = await mockWithSessions();
    const want = new Uint8Array(await (await admin.downloadSessionsCsv({})).arrayBuffer());
    const rows = asDbRows(m.store.db);
    expect(rows.flatMap(r => r.turns).some(t => t.leverage === null)).toBe(true);
    expect(rows.flatMap(r => r.turns).some(t => /\n/.test(t.text) && /"/.test(t.text))).toBe(true);
    for (const size of [1, 2, 100]) expect(await bytes(csv(pages(rows, size)))).toEqual(want);   // 쪽 경계와 무관
  });
  it('no sessions → BOM + header only, like the mock', async () => {
    const m = mockTarget(), admin = m.api('admin');
    await admin.adminLogin({ nickname: 'admin', password: ADMIN_PW });
    expect(await bytes(csv(pages([], 10)))).toEqual(new Uint8Array(await (await admin.downloadSessionsCsv({})).arrayBuffer()));
  });
});

describe('admin projections = mock (E-19, D-16)', () => {
  it('sessionRow and the AdminSessionDetail state match the mock for the same rows', async () => {
    const { m, admin: a, sids } = await mockWithSessions(), admin = a as unknown as AdminApi;   // createApi('admin') 이 좁히는 타입
    // 마지막 트리거가 중간 행에 있다(목 발화에는 멘토 행이 없어 직접 넣는다)
    m.store.db.turns.push({ session_id: sids[0], seq: 99, speaker: 'mentor', text: 'm', leverage: null, object: null, trigger: 2, created_at: tick() },
      { session_id: sids[0], seq: 100, speaker: 'student', text: 's', leverage: null, object: null, trigger: null, created_at: tick() });
    const rows = asDbRows(m.store.db);
    expect(rows.map(sessionRow)).toEqual(await admin.listAdminSessions({}));
    for (const sid of sids) {
      const r = rows.find(x => x.id === sid)!, want = await admin.getAdminSession(sid);
      expect(adminState({ mis: r.progress!.mis, counts: r.counts!, goal_reached: r.goal_reached }, r.turns)).toEqual(want.state);
    }
    expect((await admin.getAdminSession(sids[0])).state.last_trigger).toBe(2);
  });
});
