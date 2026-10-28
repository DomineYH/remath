// readAll: Data API 한 요청은 max-rows 에서 잘린다 — 목록은 range 쪽을 빈 쪽까지 이어 읽는다.
import { describe, expect, it } from 'vitest';
import { readAll } from './db.ts';

/** range 만 아는 가짜 빌더. maxRows = 서버 max-rows(요청한 쪽 크기보다 작을 수 있다). */
function fake(rows: number[], maxRows: number) {
  const ranges: [number, number][] = [];
  const query = () => ({
    range: async (from: number, to: number) => { ranges.push([from, to]); return { data: rows.slice(from, Math.min(to + 1, from + maxRows)), error: null }; },
  });
  return { query, ranges };
}

describe('readAll', () => {
  it('returns every row in order even when the server caps a page below pageSize', async () => {
    const f = fake([1, 2, 3, 4, 5], 2);
    expect(await readAll<number>(f.query, 3)).toEqual([1, 2, 3, 4, 5]);
    expect(f.ranges).toEqual([[0, 2], [2, 4], [4, 6], [5, 7]]);   // 받은 행 수만큼 넘기고 빈 쪽에서 멈춘다
  });
  it('an empty list is one request', async () => {
    const f = fake([], 2);
    expect(await readAll(f.query)).toEqual([]);
    expect(f.ranges).toEqual([[0, 999]]);
  });
  it('a Data API error is thrown', async () => {
    const err = { message: 'boom' };
    await expect(readAll(() => ({ range: async () => ({ data: null, error: err }) }))).rejects.toBe(err);
  });
});
