import { useEffect, useState } from 'react';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { teacherApi } from '../apis.ts';
import { AccountMenu } from '../components/AccountMenu.tsx';
import { AppShell } from '../components/AppShell.tsx';
import { ErrorLine } from '../components/ErrorLine.tsx';
import { Notice } from '../components/Notice.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { errorText, useT } from '../i18n/index.tsx';
import { useMe } from '../session.tsx';

/** 학생 선택. 그룹 0 → noGroup, 할당 0 → noScenario 안내. 카드는 #25. */
export function PracticeHomeScreen() {
  const t = useT(), me = useMe();
  const [home, setHome] = useState<z.infer<typeof S.PracticeHome>>(), [err, setErr] = useState<unknown>();
  useEffect(() => { teacherApi.getPractice().then(setHome, setErr); }, []);
  return (
    <AppShell account={<AccountMenu kind="teacher" nickname={me.nickname} />}>
      <PageHead eyebrow={t('pickEyebrow')} title={t('pickTitle')} lead={t('pickLead')} />
      {err !== undefined && <ErrorLine message={errorText(t, err)} />}
      {home && home.groups.length === 0 && <Notice tone="warn">{t('noAccessNoGroup', me.nickname)}</Notice>}
      {home && home.groups.length > 0 && home.scenarios.length === 0 && <Notice tone="warn">{t('noAccessNoScen', me.nickname)}</Notice>}
    </AppShell>
  );
}
