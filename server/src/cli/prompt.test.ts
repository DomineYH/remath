import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { judge, readHidden } from './prompt.ts';

/** 가짜 TTY: 입력은 raw 모드 바이트, 출력은 문자열로 모은다. */
function tty() {
  const raw: boolean[] = [];
  const input = Object.assign(new PassThrough({ encoding: 'utf8' }), { isTTY: true, setRawMode: (on: boolean) => { raw.push(on); } });
  let shown = '';
  const output = { write: (s: string) => { shown += s; return true; } };
  return { input, output, raw, shown: () => shown };
}

describe('admin:reset-password judge (H-32)', () => {
  it('accepts two equal inputs that meet the Password rules', () => {
    expect(judge('newpass12', 'newpass12')).toEqual({ ok: true, password: 'newpass12' });
  });
  it('rejects a mismatch even when both meet the rules', () => {
    expect(judge('newpass12', 'newpass13')).toEqual({ ok: false, reason: 'mismatch' });
  });
  it.each(['short1', 'onlyletters', '12345678', 'has space1'])('rejects %j by the Password rules', p => {
    expect(judge(p, p)).toEqual({ ok: false, reason: 'rules' });
  });
});

describe('admin:reset-password readHidden', () => {
  it('reads one line per prompt in raw mode without echoing, honouring backspace', async () => {
    const t = tty();
    const lines = readHidden(t.input, t.output, ['New password: ', 'Again: ']);
    t.input.write('newpass1x\x7f2\r');
    t.input.write('newpass12\r');
    expect(await lines).toEqual(['newpass12', 'newpass12']);
    expect(t.shown()).toBe('New password: \nAgain: \n');
    expect(t.raw).toEqual([true, false]);
  });
  it('handles both lines arriving in one chunk', async () => {
    const t = tty();
    const lines = readHidden(t.input, t.output, ['a: ', 'b: ']);
    t.input.write('one1\rtwo2\r');
    expect(await lines).toEqual(['one1', 'two2']);
  });
  it.each([['Ctrl-C', '\x03'], ['Ctrl-D', '\x04']])('%s aborts and restores the terminal', async (_, key) => {
    const t = tty();
    const lines = readHidden(t.input, t.output, ['a: ', 'b: ']);
    t.input.write('abc' + key);
    await expect(lines).rejects.toThrow('aborted');
    expect(t.raw).toEqual([true, false]);
  });
  it('end of input before the last line aborts', async () => {
    const t = tty();
    const lines = readHidden(t.input, t.output, ['a: ', 'b: ']);
    t.input.end('one1\r');
    await expect(lines).rejects.toThrow('aborted');
  });
});

describe('admin:reset-password readHidden cleanup', () => {
  const listeners = (t: ReturnType<typeof tty>) =>
    ['data', 'end', 'error'].map(e => t.input.listenerCount(e)).concat(['SIGHUP', 'SIGINT', 'SIGTERM'].map(s => process.listenerCount(s)));
  it('a throwing output.write on the first prompt restores the terminal and removes every listener', async () => {
    const t = tty(), before = listeners(t);
    const output = { write: () => { throw new Error('output failed'); } };
    await expect(readHidden(t.input, output, ['a: ', 'b: '])).rejects.toThrow('output failed');
    expect(t.raw.at(-1)).toBe(false);
    expect(listeners(t)).toEqual(before);
  });
  it('a throwing output.write after Enter does the same', async () => {
    const t = tty(), before = listeners(t);
    let n = 0;
    const output = { write: () => { if (++n > 1) throw new Error('output failed'); return true; } };
    const lines = readHidden(t.input, output, ['a: ', 'b: ']);
    t.input.write('one1\r');
    await expect(lines).rejects.toThrow('output failed');
    expect(t.raw).toEqual([true, false]);
    expect(listeners(t)).toEqual(before);
  });
  it('an input stream error restores the terminal and removes every listener', async () => {
    const t = tty(), before = listeners(t);
    const lines = readHidden(t.input, t.output, ['a: ', 'b: ']);
    t.input.destroy(new Error('input failed'));
    await expect(lines).rejects.toThrow('input failed');
    expect(t.raw).toEqual([true, false]);
    expect(listeners(t)).toEqual(before);
  });

  // 실제 PTY 위의 자식 node 가 READY 를 낸 뒤 SIGHUP → 터미널(ECHO·ICANON)이 되돌아오고 종료코드 128+1.
  const hasPty = spawnSync('python3', ['-c', 'import os, pty, termios; os.close(pty.openpty()[0])']).status === 0;
  const PY = String.raw`
import json, os, pty, select, signal, subprocess, sys, termios, time
m, s = pty.openpty()
p = subprocess.Popen([sys.argv[1], '--input-type=module', '-e', sys.argv[2]], stdin=s, stdout=s, start_new_session=True)
buf, end = b'', time.time() + 15
while b'READY' not in buf and time.time() < end:
    if select.select([m], [], [], 0.2)[0]: buf += os.read(m, 1024)
raw = not termios.tcgetattr(s)[3] & termios.ECHO
p.send_signal(signal.SIGHUP)
code = p.wait(15)
lf = termios.tcgetattr(s)[3]
print(json.dumps({'ready': b'READY' in buf, 'raw': raw, 'code': code, 'echo': bool(lf & termios.ECHO), 'icanon': bool(lf & termios.ICANON)}))
`;
  it.skipIf(!hasPty)('SIGHUP on a real PTY restores ECHO and ICANON and exits 129 (skipped when python3/pty is unavailable)', () => {
    const child = `import { readHidden } from ${JSON.stringify(new URL('./prompt.ts', import.meta.url).href)};
readHidden(process.stdin, process.stdout, ['READY', 'NEXT']).catch(() => {});`;
    const r = spawnSync('python3', ['-c', PY, process.execPath, child], { encoding: 'utf8', timeout: 30_000 });
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ ready: true, raw: true, code: 129, echo: true, icanon: true });
  }, 40_000);
});
