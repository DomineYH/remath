// 부하 검사 함수(#60, Q14): 세션 기록이 seq 1부터 빈틈 없이, 예비교사 발화가 보낸 순서대로인지.
import { describe, expect, it } from 'vitest';
import { checkSession } from './load.ts';

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
