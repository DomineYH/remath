// 대화 기록 탭(I-47): 사용자·시나리오 필터 → 7열 표(최신순) + "CSV 내려받기 (n건)"(0건 비활성) + "보기" → 분류 태그 달린 전체 대화와 저장된 리포트.
import { useEffect, useId, useState } from 'react';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { adminApi } from '../apis.ts';
import { AccountMenu } from '../components/AccountMenu.tsx';
import { AdminSubnav } from '../components/AdminSubnav.tsx';
import { AppShell } from '../components/AppShell.tsx';
import { Button } from '../components/Button.tsx';
import { SystemLine } from '../components/Chat.tsx';
import { ErrorLine } from '../components/ErrorLine.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { SessionReport } from '../components/SessionReport.tsx';
import { SessionsTable } from '../components/SessionsTable.tsx';
import { TranscriptModal } from '../components/TranscriptModal.tsx';
import { useDownloadCsv } from '../csv.ts';
import { pickerName } from '../pickerName.ts';
import { errorText, useT } from '../i18n/index.tsx';
import { useMe } from '../session.tsx';
import { localDateTime } from '../time.ts';

type Filter = z.infer<typeof S.SessionFilter>;
type Option = { id: string; label: string };

/** 사용자·시나리오 select 두 개 + CSV 버튼. 빈 값 = 전체. */
function LogFilters({ users, scenarios, filter, count, onChange, onCsv }: { users: Option[]; scenarios: Option[]; filter: Filter; count: number; onChange: (f: Filter) => void; onCsv: () => void }) {
  const t = useT(), id = useId();
  return (
    <div className="filters">
      <label htmlFor={`${id}-u`}>{t('fUser')}</label>
      <select id={`${id}-u`} value={filter.user_id ?? ''} onChange={e => onChange({ ...filter, user_id: e.target.value || undefined })}>
        <option value="">{t('allUsers')}</option>
        {users.map(u => <option key={u.id} value={u.id}>{u.label}</option>)}
      </select>
      <label htmlFor={`${id}-s`}>{t('fScenario')}</label>
      <select id={`${id}-s`} value={filter.scenario_id ?? ''} onChange={e => onChange({ ...filter, scenario_id: e.target.value || undefined })}>
        <option value="">{t('allScen')}</option>
        {scenarios.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <Button variant="primary" disabled={!count} onClick={onCsv}>{t('dlFiltered', String(count))}</Button>
    </div>
  );
}

export function AdminLogsScreen() {
  const t = useT(), me = useMe(), csv = useDownloadCsv();
  const [teachers, setTeachers] = useState<Option[]>([]), [scenarios, setScenarios] = useState<(Option & { slug: string })[]>([]);
  const [filter, setFilter] = useState<Filter>({}), [rows, setRows] = useState<z.infer<typeof S.SessionRow>[]>(), [err, setErr] = useState<unknown>();
  const [open, setOpen] = useState<z.infer<typeof S.SessionDetail>>();
  useEffect(() => {
    Promise.all([adminApi.listUsers(), adminApi.listScenarios()]).then(([u, s]) => {
      setTeachers(u.map(x => ({ id: x.id, label: x.nickname })));
      setScenarios(s.map(x => ({ id: x.id, label: pickerName(x, s), slug: x.slug })));
    }, setErr);
  }, []);
  useEffect(() => { adminApi.listAdminSessions(filter).then(setRows, setErr); }, [filter]);

  const users = [...teachers, { id: me.id, label: t('adminTest') }];   // 관리자 대화 테스트도 기록에 남는다
  const download = () => {
    const key = [users.find(u => u.id === filter.user_id)?.label, scenarios.find(s => s.id === filter.scenario_id)?.slug].filter(Boolean).join('_') || 'all';
    csv(filter, 'conversations', key);
  };
  const s = open?.session;
  return (
    <AppShell account={<AccountMenu kind="admin" nickname={me.nickname} />} subnav={<AdminSubnav />}>
      <PageHead eyebrow={t('logsEyebrow')} title={t('logsTitle')} lead={t('logsLead')} />
      <LogFilters users={users} scenarios={scenarios} filter={filter} count={rows?.length ?? 0} onChange={setFilter} onCsv={download} />
      {err !== undefined && <ErrorLine message={errorText(t, err)} />}
      {rows && <SessionsTable admin rows={rows} label={t('logsTitle')} empty={t('noLogs')} onView={r => adminApi.getAdminSession(r.id).then(setOpen, setErr)} />}
      <TranscriptModal open={!!open} title={s ? `${s.nickname} · ${s.scenario_name}` : ''} sub={s && `${localDateTime(s.started_at)} – ${s.ended_at ? localDateTime(s.ended_at) : '…'}`}
        turns={open?.turns ?? []} onClose={() => setOpen(undefined)}
        report={open?.report ? <SessionReport report={open.report} /> : s?.ended_at && <SystemLine>{t('endNoCls')}</SystemLine>} />
    </AppShell>
  );
}
