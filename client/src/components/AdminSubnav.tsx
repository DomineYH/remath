import { NavLink } from 'react-router';
import { useT } from '../i18n/index.tsx';

const TABS = [['scenarios', 'tabScen'], ['users', 'tabUsers'], ['groups', 'tabGroups'], ['logs', 'tabLogs'], ['ai', 'tabAI']] as const;
export type AdminTab = (typeof TABS)[number][0];

/** 관리자 5탭. 현재 탭은 NavLink 가 aria-current="page" 로 표시한다. */
export function AdminSubnav() {
  const t = useT();
  return (
    <nav className="subnav" aria-label={t('subnavAria')}>
      {TABS.map(([path, key]) => <NavLink key={path} to={`/admin/${path}`}>{t(key)}</NavLink>)}
    </nav>
  );
}
