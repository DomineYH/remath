import { useId } from 'react';
import { LEVERAGE } from '@remath/shared';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { useT } from '../i18n/index.tsx';

/** 분류 하나의 막대. Taking Over 는 orange(I-50). */
export function LeverageBar({ name, count, max, title }: { name: string; count: number; max: number; title?: string }) {
  return (
    <div className={`bar ${name === LEVERAGE.takingOver ? 'to' : ''}`}>
      <span title={title}>{name}</span>
      <div className="t"><i style={{ width: `${(count / Math.max(1, max)) * 100}%` }} /></div>
      <span className="v">{count}</span>
    </div>
  );
}

/** 세션 분석(D-17): 분류별 막대·설명·발화 목록 + 판정·도달 문장(summary). 도달점·오개념 목록은 없다. */
export function SessionReport({ report }: { report: z.infer<typeof S.SessionReport> }) {
  const t = useT(), id = useId(), max = Math.max(...report.rows.map(r => r.count));
  return (
    <section className="report" aria-labelledby={id}>
      <div className="rh"><b id={id}>{t('repHead')}</b><span className="mono muted">{t('repN', String(report.total))}</span></div>
      {report.rows.map(r => (
        <div className="rrow" key={r.name}>
          <LeverageBar name={r.name} count={r.count} max={max} />
          <div className="rdesc">{r.desc}</div>
          {r.turns.length > 0 && <ul>{r.turns.map(x => <li key={x.seq}>{x.text}</li>)}</ul>}
        </div>
      ))}
      {report.summary && <p className="rsum">{report.summary}</p>}
    </section>
  );
}
