import { describe, expect, it } from 'vitest';
import { sse } from './sse.ts';

/** 문자열 조각을 그대로 바이트 청크로 흘린다(청크 경계 = 조각 경계). */
export const body = (...chunks: string[]) => new ReadableStream<Uint8Array>({
  start(c) { const enc = new TextEncoder(); for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); },
});
const all = async (b: ReadableStream<Uint8Array>) => { const out = []; for await (const e of sse(b)) out.push(e); return out; };

describe('sse', () => {
  it('splits events on blank lines and keeps the event name', async () => {
    expect(await all(body('event: a\ndata: {"x":1}\n\ndata: two\n\n'))).toEqual([{ event: 'a', data: '{"x":1}' }, { data: 'two' }]);
  });

  it('reassembles an event split across chunk boundaries, including inside a \\r\\n and a multibyte char', async () => {
    const bytes = new TextEncoder().encode('event: delta\r\ndata: 안녕\r\n\r\n');
    const parts = [bytes.slice(0, 3), bytes.slice(3, 13), bytes.slice(13, 15), bytes.slice(15, 22), bytes.slice(22)];
    const b = new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } });
    expect(await all(b)).toEqual([{ event: 'delta', data: '안녕' }]);
  });

  it('splits a \\r\\n pair landing on a chunk boundary as one line end', async () => {
    expect(await all(body('data: a\r', '\ndata: b\r', '\n\r', '\n'))).toEqual([{ data: 'a\nb' }]);
  });

  it('joins multiline data with \\n and ignores comments and unknown fields', async () => {
    expect(await all(body(': ping\ndata: line1\nid: 7\ndata:line2\ndata\n\n'))).toEqual([{ data: 'line1\nline2\n' }]);
  });

  it('stops at the [DONE] sentinel', async () => {
    expect(await all(body('data: 1\n\nevent: done\ndata: [DONE]\n\ndata: after\n\n'))).toEqual([{ data: '1' }]);
  });

  it('flushes a last event that is not followed by a blank line', async () => {
    expect(await all(body('data: tail'))).toEqual([{ data: 'tail' }]);
  });
});
