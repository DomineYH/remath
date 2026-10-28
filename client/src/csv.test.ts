// CSV 파일 이름 날짜도 로컬 날짜다(#31 수리 I2): UTC 로 자르면 KST 자정~09시에 어제 날짜가 붙었다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { csvName } from './csv.ts';

process.env.TZ = 'Asia/Seoul';

describe('csvName', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('stamps the local date (YYYYMMDD) and replaces characters a file name cannot hold', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T15:05:00Z'));   // KST 2026-10-29 00:05
    expect(csvName('user', 'Bora Kim/1')).toBe('remath_user_Bora_Kim_1_20261029.csv');
  });
});
