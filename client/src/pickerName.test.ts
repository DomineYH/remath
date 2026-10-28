// #33: same-named scenarios are told apart by slug in pickers; names without a clash stay as they are.
import { describe, expect, it } from 'vitest';
import { pickerName } from './pickerName.ts';

const all = [{ name: '서연', slug: 'seoyeon' }, { name: '가브리엘', slug: 'gabriel' }, { name: '서연', slug: 'scenario-2489150d' }];

describe('pickerName', () => {
  it('a name shared by 2+ scenarios gets " · slug"', () => {
    expect(pickerName(all[0], all)).toBe('서연 · seoyeon');
    expect(pickerName(all[2], all)).toBe('서연 · scenario-2489150d');
  });
  it('a unique name stays as it is', () => {
    expect(pickerName(all[1], all)).toBe('가브리엘');
    expect(pickerName(all[0], [all[0], all[1]])).toBe('서연');
  });
});
