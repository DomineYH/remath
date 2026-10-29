// SSE 파서 하나(Q11). WHATWG 이벤트 스트림 규칙 중 3사 응답에 쓰이는 부분만: event·data 필드, 주석, 세 가지 줄 끝.
export interface SseEvent { event?: string; data: string }

/** 바이트 스트림 → 이벤트. `data: [DONE]`(OpenAI·Gemini 관례)에서 끝난다. 끝까지 읽지 않고 멈추면 본문을 취소한다. */
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader(), utf8 = new TextDecoder();
  let buf = '', event: string | undefined, data: string[] = [];
  try {
    for (let eof = false; !eof;) {
      const r = await reader.read();
      if (r.done) { eof = true; buf += `${utf8.decode()}\n\n`; } else buf += utf8.decode(r.value, { stream: true });   // 끝에 빈 줄을 붙여 꼬리 이벤트를 내보낸다
      for (let m; (m = /\r\n|\r|\n/.exec(buf));) {
        if (m[0] === '\r' && m.index === buf.length - 1 && !eof) break;   // 다음 청크가 \n 으로 시작할 수 있다
        const line = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length);
        if (line === '') {
          if (data.length) {
            const ev = { ...event !== undefined && { event }, data: data.join('\n') };
            if (ev.data === '[DONE]') return;
            yield ev;
          }
          event = undefined; data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const i = line.indexOf(':'), field = i < 0 ? line : line.slice(0, i), value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (field === 'data') data.push(value); else if (field === 'event') event = value;
      }
    }
  } finally { reader.cancel().catch(() => {}); }
}
