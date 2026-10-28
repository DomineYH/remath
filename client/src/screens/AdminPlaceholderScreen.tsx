import { AccountMenu } from '../components/AccountMenu.tsx';
import { AdminSubnav } from '../components/AdminSubnav.tsx';
import { AppShell } from '../components/AppShell.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { useT } from '../i18n/index.tsx';
import type { DictKey } from '../i18n/dict.ts';
import { useMe } from '../session.tsx';

/** 사용자·그룹·대화 기록·AI 설정 탭의 자리(#25·#27 이 채운다). */
export function AdminPlaceholderScreen({ title }: { title: DictKey }) {
  const t = useT(), me = useMe();
  return (
    <AppShell account={<AccountMenu kind="admin" nickname={me.nickname} />} subnav={<AdminSubnav />}>
      <PageHead eyebrow={t('adminEyebrow')} title={t(title)} />
      <p className="muted">{t('comingSoon')}</p>
    </AppShell>
  );
}
