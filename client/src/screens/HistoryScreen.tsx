// 내 기록(I-53): 내 연습 세션 최신순 + "보기" → 전체 대화와 종료 때와 같은 리포트(저장본).
import { useEffect, useState } from 'react';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { teacherApi } from '../apis.ts';
import { AccountMenu } from '../components/AccountMenu.tsx';
import { AppShell } from '../components/AppShell.tsx';
import { ErrorLine } from '../components/ErrorLine.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { SessionReport } from '../components/SessionReport.tsx';
import { SessionsTable } from '../components/SessionsTable.tsx';
import { SystemLine } from '../components/Chat.tsx';
import { TranscriptModal } from '../components/TranscriptModal.tsx';
import { errorText, useT } from '../i18n/index.tsx';
import { useMe } from '../session.tsx';
import { localDateTime } from '../time.ts';

type Detail = z.infer<typeof S.SessionDetail>;

export function HistoryScreen() {
  const t = useT(), me = useMe();
  const [rows, setRows] = useState<z.infer<typeof S.SessionRow>[]>(), [err, setErr] = useState<unknown>(), [open, setOpen] = useState<Detail>();
  useEffect(() => { teacherApi.listSessions().then(setRows, setErr); }, []);
  const s = open?.session;
  return (
    <AppShell account={<AccountMenu kind="teacher" nickname={me.nickname} />}>
      <PageHead eyebrow={t('histEyebrow')} title={t('histTitle')} lead={t('histLead')} />
      {err !== undefined && <ErrorLine message={errorText(t, err)} />}
      {rows && <SessionsTable rows={rows} label={t('histTitle')} onView={r => teacherApi.getSession(r.id).then(setOpen, setErr)} />}
      <TranscriptModal open={!!open} title={s?.scenario_name ?? ''} sub={s && `${localDateTime(s.started_at)} – ${s.ended_at ? localDateTime(s.ended_at) : '…'}`}
        turns={open?.turns ?? []} onClose={() => setOpen(undefined)}
        report={open?.report ? <SessionReport report={open.report} /> : s?.ended_at && <SystemLine>{t('endNoCls')}</SystemLine>} />
    </AppShell>
  );
}
