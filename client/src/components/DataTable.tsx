import type { ReactNode } from 'react';

/** 표 하나. 가로 스크롤은 .tbl-wrap 안에서만(I-54). wide = 관리자 7열 표의 min-width 860px. 빈 표는 empty 한 줄. */
export function DataTable({ head, rows, wide, empty, label }: { head: ReactNode[]; rows: { key: string; cells: ReactNode[] }[]; wide?: boolean; empty: string; label: string }) {
  return (
    <div className="tbl-wrap">
      <table className={wide ? 'tbl wide' : 'tbl'} aria-label={label}>
        <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.length
            ? rows.map(r => <tr key={r.key}>{r.cells.map((c, i) => <td key={i}>{c}</td>)}</tr>)
            : <tr><td colSpan={head.length} className="muted">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
