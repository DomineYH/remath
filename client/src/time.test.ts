// 화면 날짜·시각은 브라우저 로컬 시간대로 보인다(#31). UTC ISO 를 잘라 쓰면 KST 12:47 이 03:47 로 보였다.
import { describe, expect, it } from 'vitest';
import { localDate, localDateTime } from './time.ts';

process.env.TZ = 'Asia/Seoul';   // Node 는 실행 중 TZ 변경을 다음 Date 계산부터 반영한다

describe('local time formatter', () => {
  it('date-time: YYYY-MM-DD HH:MM in local time', () => {
    expect(localDateTime('2026-10-28T03:47:00Z')).toBe('2026-10-28 12:47');
    expect(localDateTime('2026-10-28T15:05:09.123Z')).toBe('2026-10-29 00:05');   // 날짜도 넘어간다
  });
  it('date: YYYY-MM-DD in local time', () => {
    expect(localDate('2026-10-28T03:47:00Z')).toBe('2026-10-28');
    expect(localDate('2026-12-31T16:00:00Z')).toBe('2027-01-01');
  });
});
