/** A scenario's label in pickers: a name shared by 2+ scenarios gets its slug, e.g. `서연 · seoyeon` (#33). */
export function pickerName(s: { name: string; slug: string }, all: { name: string }[]): string {
  return all.filter(x => x.name === s.name).length > 1 ? `${s.name} · ${s.slug}` : s.name;
}
