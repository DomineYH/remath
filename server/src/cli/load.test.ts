// 부하 검사 함수(#60, Q14): 세션 기록이 seq 1부터 빈틈 없이, 예비교사 발화가 보낸 순서대로인지.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '../../../client/src/api/types.ts';
import { checkSession, runLoad, type LoadEnv } from './load.ts';

const t = (seq: number, speaker: 'teacher' | 'student' | 'mentor', text: string) =>
  ({ seq, speaker, text, leverage: null, object: null, trigger: null, created_at: '2026-10-29T00:00:00.000Z' });

describe('checkSession', () => {
  const sent = ['a', 'b'];
  it('passes a clean history: greeting, then teacher/student/mentor per turn', () => {
    expect(checkSession(sent, [t(1, 'student', 'hi'), t(2, 'teacher', 'a'), t(3, 'student', 'x'), t(4, 'mentor', 'm'), t(5, 'teacher', 'b'), t(6, 'student', 'y')])).toEqual([]);
  });
  it('catches a seq gap', () => {
    expect(checkSession(sent, [t(1, 'student', 'hi'), t(2, 'teacher', 'a'), t(4, 'student', 'x'), t(5, 'teacher', 'b')]))
      .toEqual(['seq not 1..n: 1,2,4,5']);
  });
  it('catches teacher texts out of order or missing', () => {
    expect(checkSession(sent, [t(1, 'student', 'hi'), t(2, 'teacher', 'b'), t(3, 'teacher', 'a')]))
      .toEqual(['teacher texts differ from sent order']);
    expect(checkSession(sent, [t(1, 'student', 'hi'), t(2, 'teacher', 'a')])).toEqual(['teacher texts differ from sent order']);
  });
});

// runLoad 준비·정리(S2·C5): 가짜 관리자/예비교사 API. 사용자 생성은 i 번째가 i ms 늦게 커밋된다.
describe('runLoad setup and cleanup', () => {
  const ENV: LoadEnv = { LOAD_BASE: 'http://load.test', LOAD_ADMIN_PASSWORD: 'pw', LOAD_USERS: 4, LOAD_TURNS: 1, LOAD_SCENARIO: '33333333-3333-4333-8333-333333333333' };
  function fakeApis(o: { failCreate?: number; failDelete?: boolean; keepDeleted?: boolean } = {}) {
    const users: { id: string; nickname: string }[] = [], deleted: string[] = [];
    const admin = {
      adminLogin: async () => ({}),
      createUser: ({ nickname }: { nickname: string }) => new Promise((resolve, reject) => {
        const i = Number(nickname.split('-').pop());
        if (i === o.failCreate) return reject(new Error('create failed'));
        setTimeout(() => { const u = { id: `u${i}`, nickname }; users.push(u); resolve(u); }, i * 5);
      }),
      listUsers: async () => [...users],
      deleteUser: async (id: string) => {
        if (o.failDelete) throw new Error('delete failed');
        deleted.push(id);
        if (!o.keepDeleted) users.splice(users.findIndex(u => u.id === id), 1);
      },
      createGroup: async () => ({ id: 'g1' }), deleteGroup: async () => {},
    };
    const teacher = (sent = '') => ({
      login: async () => ({}), getPractice: async () => ({}), startSession: async () => ({ session: { id: 's1' } }),
      async *sendTurn(_: string, { text }: { text: string }) { sent = text; yield { type: 'done' }; },
      endSession: async () => {}, listSessions: async () => [],
      getSession: async () => ({ turns: [t(1, 'student', 'hi'), t(2, 'teacher', sent), t(3, 'student', 'x')] }),
    });
    return { users, deleted, browser: (realm: string) => (realm === 'admin' ? admin : teacher()) as unknown as Api };
  }
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'table').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('a clean run with full cleanup succeeds', async () => {
    const f = fakeApis();
    expect(await runLoad(ENV, f.browser)).toBe(true);
    expect(f.users).toEqual([]);
  });
  it('a failed user creation fails the run, and cleanup still deletes the slower creations', async () => {
    const f = fakeApis({ failCreate: 1 });
    await expect(runLoad(ENV, f.browser)).rejects.toThrow(/not created/);
    expect(f.deleted.sort()).toEqual(['u2', 'u3', 'u4']);
    expect(f.users).toEqual([]);
  });
  it('a cleanup delete failure fails the run', async () => {
    expect(await runLoad(ENV, fakeApis({ failDelete: true }).browser)).toBe(false);
  });
  it('load-* users left after cleanup fail the run', async () => {
    expect(await runLoad(ENV, fakeApis({ keepDeleted: true }).browser)).toBe(false);
  });
});
