// AI 설정 탭(I-48): 요약 타일 3개 + 챗봇 카드 3개. 저장하면 설정을 다시 읽는다(키를 함께 쓰는 다른 챗봇의 상태도 바뀐다).
import { useCallback, useEffect, useState } from 'react';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { adminApi } from '../apis.ts';
import { AccountMenu } from '../components/AccountMenu.tsx';
import { AdminSubnav } from '../components/AdminSubnav.tsx';
import { AiBotCard, AiSummaryTiles, ROLES } from '../components/AiSettings.tsx';
import { AppShell } from '../components/AppShell.tsx';
import { ErrorLine } from '../components/ErrorLine.tsx';
import { Notice } from '../components/Notice.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { errorText, useT } from '../i18n/index.tsx';
import { useMe } from '../session.tsx';

export function AdminAiScreen() {
  const t = useT(), me = useMe();
  const [settings, setSettings] = useState<z.infer<typeof S.AiSettings>>(), [providers, setProviders] = useState<z.infer<typeof S.ProvidersFile>>(), [err, setErr] = useState<unknown>();
  const reload = useCallback(() => adminApi.getAiSettings().then(setSettings, setErr), []);
  useEffect(() => { reload(); adminApi.getProviders().then(setProviders, setErr); }, [reload]);
  return (
    <AppShell account={<AccountMenu kind="admin" nickname={me.nickname} />} subnav={<AdminSubnav />}>
      <PageHead eyebrow={t('aiEyebrow')} title={t('aiTitle')} lead={t('aiLead')} />
      <Notice tone="info">{t('aiNotice')}</Notice>
      {err !== undefined && <ErrorLine message={errorText(t, err)} />}
      {settings && providers && <>
        <AiSummaryTiles settings={settings} providers={providers} />
        <div className="ai-grid">
          {ROLES.map(r => <AiBotCard key={r} role={r} settings={settings} providers={providers} onSaved={reload} />)}
          <p className="hint ai-note">{t('modelNote')}</p>
        </div>
      </>}
    </AppShell>
  );
}
