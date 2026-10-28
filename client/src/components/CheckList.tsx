import type { ReactNode } from 'react';

/** 체크박스 목록(fieldset + legend). 값은 고른 id 배열. 항목이 없으면 empty 문구. */
export function CheckList({ legend, hint, items, value, onChange, empty }: {
  legend: string; hint?: string; items: { id: string; label: ReactNode }[]; value: string[]; onChange: (v: string[]) => void; empty: string;
}) {
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter(x => x !== id));
  return (
    <fieldset className="field">
      <legend>{legend}{hint && <> <span className="hint">{hint}</span></>}</legend>
      {items.length
        ? <div className="ckl">{items.map(i => <label key={i.id}><input type="checkbox" checked={value.includes(i.id)} onChange={e => toggle(i.id, e.target.checked)} /> {i.label}</label>)}</div>
        : <p className="hint">{empty}</p>}
    </fieldset>
  );
}
