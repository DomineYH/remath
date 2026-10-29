// 부하 점검 (#60, Q14): 예비교사 N명이 동시에 로그인→세션 시작→턴 N회→종료→기록 조회. CI 밖에서 수동 실행.
// 실행: `LOAD_BASE=http://… LOAD_ADMIN_PASSWORD=… npm run load -w server` (LOAD_USERS=30, LOAD_TURNS=10, LOAD_SCENARIO=게시된 시나리오 id, 없으면 첫 게시본).
// 만든 것(사용자 load-<run>-<i>, 임시 그룹 load-<run>)은 실패해도 finally 에서 관리자 API로 지운다(사용자 삭제 = 기록 cascade).
import { z } from 'zod';
import type * as S from '@remath/shared';
import { createHttpApi } from '../../../client/src/api/http.ts';
import { ApiError, type Api } from '../../../client/src/api/types.ts';
import { jarFetch } from '../test-http/jar.ts';
import { main, readEnv } from './main.ts';

type Turn = z.infer<typeof S.Turn>;

/** 세션 기록 검사: seq 가 1부터 빈틈 없이 증가하고, 예비교사 발화가 보낸 순서·내용 그대로인지. 문제 목록(없으면 []). */
export function checkSession(sent: string[], turns: Turn[]): string[] {
  const problems: string[] = [], seqs = turns.map(t => t.seq);
  if (seqs.some((s, i) => s !== i + 1)) problems.push(`seq not 1..n: ${seqs.join(',')}`);
  const said = turns.filter(t => t.speaker === 'teacher').map(t => t.text);
  if (said.length !== sent.length || said.some((s, i) => s !== sent[i])) problems.push('teacher texts differ from sent order');
  return problems;
}

/** 최근순위(nearest-rank) 백분위수, ms. */
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.ceil(p / 100 * s.length) - 1]! : NaN; };

interface Tally { first: number[]; turn: number[]; http429: number; http5xx: number; sseError: number; check: number; other: number; notes: string[] }

async function teacher(api: Api, nickname: string, password: string, scenario: string, turns: number, run: string, t: Tally) {
  await api.login({ nickname, password });
  await api.getPractice();
  const { session } = await api.startSession({ scenario_id: scenario });
  const sent: string[] = [];
  for (let k = 1; k <= turns; k++) {
    // 고유 표지(LDTX-…)는 서버 로그 grep 용: 발화 텍스트가 로그에 남지 않아야 한다.
    const text = `LDTX-${run}-${nickname.split('-').pop()}-${k} 그림으로 다시 설명해 볼래?`;
    const t0 = performance.now();
    let first = 0, done = false;
    for await (const e of api.sendTurn(session.id, { text })) {
      first ||= performance.now() - t0;
      if (e.type === 'error') { t.sseError++; t.notes.push(`${nickname} turn ${k}: sse error ${e.code}`); }
      if (e.type === 'done') done = true;
    }
    if (!done) break;   // error 이벤트 = 이 턴은 기록되지 않음. 이후 순서 검사가 어긋나므로 멈춘다
    sent.push(text);
    t.first.push(first); t.turn.push(performance.now() - t0);
  }
  await api.endSession(session.id);
  await api.listSessions();
  const problems = checkSession(sent, (await api.getSession(session.id)).turns);
  if (sent.length < turns) problems.push(`only ${sent.length}/${turns} turns done`);
  t.check += problems.length;
  t.notes.push(...problems.map(p => `${nickname}: ${p}`));
}

const Env = z.object({
  LOAD_BASE: z.url(), LOAD_ADMIN_PASSWORD: z.string().min(1),
  LOAD_USERS: z.coerce.number().int().positive().default(30), LOAD_TURNS: z.coerce.number().int().positive().default(10),
  LOAD_SCENARIO: z.uuid().optional(),
});

export type LoadEnv = z.infer<typeof Env>;

/** 한 번 실행. browser(realm) = 쿠키 따로 쓰는 새 클라이언트. 부하·검사 실패가 하나라도 있으면 false, 준비 실패는 throw. */
export async function runLoad(env: LoadEnv, browser: (realm: 'teacher' | 'admin') => Api): Promise<boolean> {
  const base = env.LOAD_BASE.replace(/\/$/, ''), admin = browser('admin');
  await admin.adminLogin({ nickname: 'admin', password: env.LOAD_ADMIN_PASSWORD });
  const run = Math.random().toString(36).slice(2, 6), prefix = `load-${run}-`, password = `Load${run}x2026`;
  const t: Tally = { first: [], turn: [], http429: 0, http5xx: 0, sseError: 0, check: 0, other: 0, notes: [] };
  const fail = (who: string, err: unknown) => {
    if (err instanceof ApiError && err.status === 429) t.http429++;
    else if (err instanceof ApiError && err.status >= 500) t.http5xx++;
    else t.other++;
    t.notes.push(`${who}: ${err instanceof ApiError ? `${err.status} ${err.code}` : (err as Error).message}`);
  };
  let group: string | undefined, dirty = false;   // dirty = 정리 실패·잔여 → 실행 실패
  try {
    const scenario = env.LOAD_SCENARIO ?? (await admin.listScenarios()).find(s => s.status === 'published')?.id;
    if (!scenario) throw new Error('no published scenario');
    // 모두 끝날 때까지 기다린다: 하나가 먼저 실패해도 느린 생성이 정리 뒤에 커밋되면 남는다.
    const created = await Promise.allSettled(Array.from({ length: env.LOAD_USERS }, (_, i) => admin.createUser({ nickname: prefix + (i + 1), password })));
    const failed = created.filter(r => r.status === 'rejected');
    if (failed.length) throw new Error(`${failed.length}/${env.LOAD_USERS} users not created: ${(failed[0]!.reason as Error).message}`);
    const users = created.map(r => (r as PromiseFulfilledResult<z.infer<typeof S.UserRow>>).value);
    group = (await admin.createGroup({ name: `load-${run}`, member_ids: users.map(u => u.id), scenario_ids: [scenario] })).id;
    const t0 = performance.now();
    await Promise.all(users.map(u => teacher(browser('teacher'), u.nickname, password, scenario, env.LOAD_TURNS, run, t).catch(err => fail(u.nickname, err))));
    const ms = (x: number) => `${Math.round(x)} ms`;
    console.log(`load run ${run}: ${env.LOAD_USERS} users × ${env.LOAD_TURNS} turns against ${base} in ${ms(performance.now() - t0)}`);
    console.table({
      'first event': { p50: ms(pct(t.first, 50)), p95: ms(pct(t.first, 95)), n: t.first.length },
      'turn (to done)': { p50: ms(pct(t.turn, 50)), p95: ms(pct(t.turn, 95)), n: t.turn.length },
    });
    console.table({ failures: { 'HTTP 429': t.http429, 'HTTP 5xx': t.http5xx, 'SSE error': t.sseError, 'check (seq/order)': t.check, other: t.other } });
    for (const n of t.notes) console.log('  ' + n);
  } finally {
    // 목록에서 접두어로 찾는다: 생성이 중간에 실패했어도 만들어진 것은 모두 지운다.
    if (group) await admin.deleteGroup(group).catch(err => { dirty = true; console.error(`cleanup: group delete failed: ${(err as Error).message}`); });
    for (const u of (await admin.listUsers()).filter(u => u.nickname.startsWith(prefix)))
      await admin.deleteUser(u.id).catch(err => { dirty = true; console.error(`cleanup: ${u.nickname} delete failed: ${(err as Error).message}`); });
    const left = (await admin.listUsers()).filter(u => u.nickname.startsWith(prefix)).length;
    if (left) dirty = true;
    console.log(`cleanup: ${left} ${prefix}* users left${group ? `, group load-${run} deleted` : ''}`);
  }
  return !(dirty || t.http429 + t.http5xx + t.sseError + t.check + t.other);
}

if (import.meta.main) main('load', async () => {
  const env = readEnv(Env, process.env), base = env.LOAD_BASE.replace(/\/$/, '');
  if (!await runLoad(env, realm => createHttpApi({ realm, fetch: jarFetch(), base }))) process.exitCode = 1;
});
