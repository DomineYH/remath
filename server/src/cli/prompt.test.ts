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
