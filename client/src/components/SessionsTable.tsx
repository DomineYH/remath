import type * as S from '@remath/shared';
import type { z } from 'zod';
import { useT } from '../i18n/index.tsx';
import { Button } from './Button.tsx';
import { DataTable } from './DataTable.tsx';
import { Pill } from './Pill.tsx';

type Row = z.infer<typeof S.SessionRow>;

const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** 내 기록 5열(시작·시나리오·발화 수·도달 여부·보기, min-width 없음, I-53). admin = 관리자 대화 기록 7열(+ 닉네임·언어, min-width 860px, I-47). */
export function SessionsTable({ rows, label, empty, admin, onView }: { rows: Row[]; label: string; empty?: string; admin?: boolean; onView: (r: Row) => void }) {
  const t = useT();
  return (
    <DataTable wide={admin} label={label} empty={empty ?? t('noHist')}
      head={admin ? [t('thDate'), t('thNick'), t('thScen'), t('thLang'), t('thTurns'), t('thReached'), ''] : [t('thDate'), t('thScen'), t('thTurns'), t('thReached'), '']}
      rows={rows.map(r => ({
        key: r.id, cells: [
          <span className="mono">{when(r.started_at)}</span>,
          ...(admin ? [r.nickname] : []),
          r.scenario_name,
          ...(admin ? [r.lang === 'en' ? 'English' : '한국어'] : []),
          <span className="mono">{r.turn_count}</span>,
          r.ended_at ? <Pill tone={r.goal_reached ? 'pub' : undefined}>{t(r.goal_reached ? 'yes' : 'no')}</Pill> : <Pill tone="draft">{t('inProgress')}</Pill>,
          <div className="acts-cell"><Button size="sm" onClick={() => onView(r)} aria-label={`${t('view')} · ${admin ? `${r.nickname} · ` : ''}${r.scenario_name} · ${when(r.started_at)}`}>{t('view')}</Button></div>,
        ],
      }))} />
  );
}
