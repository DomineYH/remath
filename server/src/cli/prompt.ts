// admin:reset-password 의 순수 부분(H-32): 입력 2개 판정과 TTY 에코 없는 프롬프트. 스트림은 주입받는다.
import { Password } from '@remath/shared';

export type Verdict = { ok: true; password: string } | { ok: false; reason: 'mismatch' | 'rules' };

/** 두 입력이 같고 `Password` 규칙(8자 이상 · 영문+숫자 · 공백 없음)을 지키면 통과. */
export function judge(first: string, second: string): Verdict {
  if (first !== second) return { ok: false, reason: 'mismatch' };
  return Password.safeParse(first).success ? { ok: true, password: first } : { ok: false, reason: 'rules' };
}

export interface TtyIn extends NodeJS.ReadableStream { setRawMode(on: boolean): unknown }

/**
 * prompts 마다 한 줄씩, raw 모드로 받아 입력 문자를 화면에 내지 않는다. Enter 로 다음 줄, Backspace 로 한 글자 지움.
 * Ctrl-C·Ctrl-D·입력 끝이면 'aborted' 로 거부한다. 어느 쪽이든 raw 모드를 되돌리고 입력을 멈춘다.
 */
export function readHidden(input: TtyIn, output: { write(s: string): unknown }, prompts: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let cur = '';
    const finish = (err?: Error) => {
      input.off('data', onData).off('end', onEnd);
      input.setRawMode(false);
      input.pause();
      if (err) reject(err); else resolve(lines);
    };
    const onEnd = () => finish(new Error('aborted'));
    const onData = (chunk: string | Buffer) => {
      for (const ch of String(chunk)) {
        if (ch === '\x03' || ch === '\x04') { output.write('\n'); return finish(new Error('aborted')); }
        if (ch === '\r' || ch === '\n') {
          output.write('\n');
          lines.push(cur);
          cur = '';
          if (lines.length === prompts.length) return finish();
          output.write(prompts[lines.length]!);
        } else if (ch === '\x7f' || ch === '\b') cur = cur.slice(0, -1);
        else cur += ch;
      }
    };
    input.setEncoding('utf8');   // 여러 바이트 문자가 청크 경계에서 잘리지 않게
    input.setRawMode(true);
    input.on('data', onData).on('end', onEnd);
    input.resume();
    output.write(prompts[0]!);
  });
}
