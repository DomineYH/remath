import type * as S from '@remath/shared';
import type { z } from 'zod';
import { useT } from '../i18n/index.tsx';
import { Button } from './Button.tsx';
import { DataTable } from './DataTable.tsx';
import { Pill } from './Pill.tsx';

type Row = z.infer<typeof S.SessionRow>;

/** 내 기록 5열(시작·시나리오·발화 수·도달 여부·보기, min-width 없음, I-53). */
export function SessionsTable({ rows, label, onView }: { rows: Row[]; label: string; onView: (r: Row) => void }) {
  const t = useT();
  return (
    <DataTable label={label} empty={t('noHist')} head={[t('thDate'), t('thScen'), t('thTurns'), t('thReached'), '']}
      rows={rows.map(r => ({
        key: r.id, cells: [
          <span className="mono">{r.started_at.slice(0, 16).replace('T', ' ')}</span>,
          r.scenario_name,
          <span className="mono">{r.turn_count}</span>,
          r.ended_at ? <Pill tone={r.goal_reached ? 'pub' : undefined}>{t(r.goal_reached ? 'yes' : 'no')}</Pill> : <Pill tone="draft">{t('inProgress')}</Pill>,
          <div className="acts-cell"><Button size="sm" onClick={() => onView(r)} aria-label={`${t('view')} · ${r.scenario_name} · ${r.started_at.slice(0, 16).replace('T', ' ')}`}>{t('view')}</Button></div>,
        ],
      }))} />
  );
}
