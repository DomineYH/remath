import { useEffect, useState } from 'react';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { adminApi } from '../apis.ts';
import { AccountMenu } from '../components/AccountMenu.tsx';
import { AdminSubnav } from '../components/AdminSubnav.tsx';
import { AppShell } from '../components/AppShell.tsx';
import { ErrorLine } from '../components/ErrorLine.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { errorText, useT } from '../i18n/index.tsx';
import { useMe } from '../session.tsx';

/** 시나리오 목록. 1차는 빈 상태 한 줄(카드는 #23). */
export function AdminScenariosScreen() {
  const t = useT(), me = useMe();
  const [list, setList] = useState<z.infer<typeof S.ScenarioSummary>[]>(), [err, setErr] = useState<unknown>();
  useEffect(() => { adminApi.listScenarios().then(setList, setErr); }, []);
  return (
    <AppShell account={<AccountMenu kind="admin" nickname={me.nickname} />} subnav={<AdminSubnav />}>
      <PageHead eyebrow={t('adminEyebrow')} title={t('listTitle')} lead={t('listLead')} />
      {err !== undefined && <ErrorLine message={errorText(t, err)} />}
      {list?.length === 0 && <p className="muted">{t('noScenarios')}</p>}
    </AppShell>
  );
}
