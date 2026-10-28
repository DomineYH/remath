// 내부 상태 패널(I-52, 관리자 대화 테스트 전용). 상태는 `state` 이벤트·getAdminSession 에서만, 문구는 관리자 시나리오 응답에서 온다.
import { useEffect, useId, useState, type ReactNode } from 'react';
import { TRIGGER } from '@remath/shared';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { adminApi } from '../apis.ts';
import { useT, type T } from '../i18n/index.tsx';
import { LeverageBar } from './SessionReport.tsx';

type AdminState = z.infer<typeof S.AdminState>;
type Row = z.infer<typeof S.ClassificationRow>;

export const triggerText = (t: T, n: AdminState['last_trigger']) => t(n === TRIGGER.takingOver ? 'trig1' : n === TRIGGER.help ? 'trig2' : n === TRIGGER.goal ? 'trig3hit' : 'none');

function Box({ title, extra, children }: { title: string; extra?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="rbox" aria-labelledby={id}>
      <h4><span id={id}>{title}</span>{extra && <span className="muted mono">{extra}</span>}</h4>
      {children}
    </section>
  );
}

export function LeverageBars({ rows, counts, turns }: { rows: Row[]; counts: AdminState['counts']; turns: number }) {
  const t = useT(), max = Math.max(0, ...rows.map(r => counts[r.name] ?? 0));
  return (
    <Box title={t('rLev')} extra={t('turnsN', String(turns))}>
      {rows.length ? rows.map(r => <LeverageBar key={r.name} name={r.name} title={r.desc} count={counts[r.name] ?? 0} max={max} />) : <p>{t('railNoCls')}</p>}
    </Box>
  );
}

/** mis[i] 와 internal.misconceptions[i].text 를 순서로 묶는다. 2/2 는 ✓. */
export function MisconceptionTrack({ texts, mis, reached }: { texts: string[]; mis: number[]; reached: boolean }) {
  const t = useT();
  return (
    <Box title={t('rMis')} extra={`${mis.filter(n => n >= 2).length}/${texts.length}`}>
      <ul className="mlist">
        {texts.map((text, i) => {
          const n = mis[i] ?? 0;
          return <li className="mitem" key={i}><span className={`dot ${n >= 2 ? 'full' : n === 1 ? 'half' : ''}`} title={`${n}/2`}>{n >= 2 ? '✓' : `${n}/2`}</span><span>{text}</span></li>;
        })}
        {reached && <li className="mitem"><span className="dot full">✓</span><b>{t('goalReached')}</b></li>}
      </ul>
    </Box>
  );
}

export function ConnectedModels() {
  const t = useT(), [ai, setAi] = useState<z.infer<typeof S.AiSettings>>();
  useEffect(() => { adminApi.getAiSettings().then(setAi, () => {}); }, []);
  const roles = [['student', 'roleStudent'], ['mentor', 'roleMentor'], ['analysis', 'roleAnalysis']] as const;
  return (
    <Box title={t('rAI')}>
      {roles.map(([r, label]) => {
        const s = ai?.[r];
        return <div className="ai-mini-row" key={r}><span>{t(label)}</span><b className="mono">{s?.model ? [s.provider, s.model, s.effort].filter(Boolean).join(' · ') : t('notSet')}</b></div>;
      })}
      <p className="hint">{t('mockReplies')}</p>
    </Box>
  );
}

export function InternalPanel({ state, leverage, misconceptions, goal, turns }: { state: AdminState; leverage: Row[]; misconceptions: string[]; goal: string; turns: number }) {
  const t = useT();
  return (
    <aside className="rail" aria-label={t('railAria')}>
      <div className="secret">{t('secret')}</div>
      <LeverageBars rows={leverage} counts={state.counts} turns={turns} />
      <MisconceptionTrack texts={misconceptions} mis={state.mis} reached={state.goal_reached} />
      <Box title={t('rGoal')}><p>{goal}</p></Box>
      <Box title={t('rTrig')}><p className="muted">{triggerText(t, state.last_trigger)}</p></Box>
      <ConnectedModels />
    </aside>
  );
}
