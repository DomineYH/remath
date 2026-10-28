// D-17: the server-computed report — verdict rules, rows snapshot, total, reached; null without criteria.
import { describe, expect, it } from 'vitest';
import { sessionReport } from './index.ts';

const lev = (...names: string[]) => names.map(name => ({ name, desc: `${name} desc`, ex: '' }));
const t = (seq: number, leverage: string | null, speaker: 'teacher' | 'student' | 'mentor' = 'teacher') => ({ seq, speaker, text: `q${seq}`, leverage });

describe('sessionReport', () => {
  it('rows follow criteria order with desc snapshot and the teacher turns of each category', () => {
    const r = sessionReport(lev('Eliciting', 'Extending', 'Taking Over', 'Other'), [t(1, null, 'student'), t(2, 'Other'), t(4, 'Eliciting'), t(5, 'Eliciting', 'student'), t(6, 'Extending'), t(8, 'Eliciting')], true, 'Nice.');
    expect(r).toEqual({
      total: 4, reached: true, verdict: 'clean', summary: 'Nice.',
      rows: [
        { name: 'Eliciting', desc: 'Eliciting desc', count: 2, turns: [{ seq: 4, text: 'q4' }, { seq: 8, text: 'q8' }] },
        { name: 'Extending', desc: 'Extending desc', count: 1, turns: [{ seq: 6, text: 'q6' }] },
        { name: 'Taking Over', desc: 'Taking Over desc', count: 0, turns: [] },
        { name: 'Other', desc: 'Other desc', count: 1, turns: [{ seq: 2, text: 'q2' }] },
      ],
    });
  });
  it('verdicts: none · clean · heavy · mixed · dist', () => {
    const std = lev('Eliciting', 'Extending', 'Taking Over', 'Other');
    const v = (turns: ReturnType<typeof t>[], rows = std) => sessionReport(rows, turns, false, null)?.verdict;
    expect(v([t(2, 'Other')])).toBe('none');
    expect(v([t(2, 'Extending')])).toBe('clean');
    expect(v([t(2, 'Taking Over'), t(4, 'Taking Over'), t(6, 'Eliciting')])).toBe('heavy');
    expect(v([t(2, 'Taking Over'), t(4, 'Eliciting')])).toBe('mixed');
    expect(v([t(2, 'Probing')], lev('Probing', 'Telling'))).toBe('dist');
  });
  it('no leverage criteria → null', () => {
    expect(sessionReport([], [t(2, null)], true, null)).toBeNull();
  });
});
