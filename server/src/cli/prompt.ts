// admin:reset-password 의 순수 부분(H-32): 입력 2개 판정과 TTY 에코 없는 프롬프트. 스트림은 주입받는다.
import { constants } from 'node:os';
import { Password } from '@remath/shared';

export type Verdict = { ok: true; password: string } | { ok: false; reason: 'mismatch' | 'rules' };

/** 두 입력이 같고 `Password` 규칙(8자 이상 · 영문+숫자 · 공백 없음)을 지키면 통과. */
export function judge(first: string, second: string): Verdict {
  if (first !== second) return { ok: false, reason: 'mismatch' };
  return Password.safeParse(first).success ? { ok: true, password: first } : { ok: false, reason: 'rules' };
}

export interface TtyIn extends NodeJS.ReadableStream { setRawMode(on: boolean): unknown }

// raw 모드에서는 Ctrl-C 가 신호가 아니라 바이트로 온다. 그래도 kill·터미널 끊김은 신호로 오므로 그동안만 잡는다(SIGKILL 은 불가).
const SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;

/**
 * prompts 마다 한 줄씩, raw 모드로 받아 입력 문자를 화면에 내지 않는다. Enter 로 다음 줄, Backspace 로 한 글자 지움.
 * Ctrl-C·Ctrl-D·입력 끝이면 'aborted', 입출력 오류면 그 오류로 거부한다. 어느 경우든 finish 하나가 raw 모드를 되돌리고
 * 리스너를 모두 뗀다. 위 신호가 오면 같은 정리 뒤 128+신호번호로 프로세스를 끝낸다.
 */
export function readHidden(input: TtyIn, output: { write(s: string): unknown }, prompts: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let cur = '', done = false;
    const finish = (err?: unknown) => {
      if (done) return;
      done = true;
      input.off('data', onData).off('end', onEnd).off('error', finish);
      for (const sig of SIGNALS) process.off(sig, onSignal);
      try { input.setRawMode(false); input.pause(); } catch (e) { err ??= e; }
      if (err) reject(err); else resolve(lines);
    };
    const onEnd = () => finish(new Error('aborted'));
    const onSignal = (sig: NodeJS.Signals) => {
      finish(new Error(sig));
      process.exit(128 + constants.signals[sig]);
    };
    const onData = (chunk: string | Buffer) => {
      try {
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
      } catch (err) { finish(err); }
    };
    try {
      input.setEncoding('utf8');   // 여러 바이트 문자가 청크 경계에서 잘리지 않게
      input.on('data', onData).on('end', onEnd).on('error', finish);
      for (const sig of SIGNALS) process.on(sig, onSignal);
      input.setRawMode(true);
      input.resume();
      output.write(prompts[0]!);
    } catch (err) { finish(err); }
  });
}
