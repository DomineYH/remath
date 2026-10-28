import { useState, type ReactNode } from 'react';
import { useLang, useT } from '../i18n/index.tsx';
import { effectiveTheme, setTheme, type Theme } from '../theme.ts';
import { SegmentedToggle } from './SegmentedToggle.tsx';

/** 브랜드 · 계정 메뉴 슬롯 · 한│EN · 테마 버튼. */
export function TopBar({ account }: { account?: ReactNode }) {
  const t = useT(), { lang, setLang } = useLang();
  const [theme, setThemeState] = useState<Theme>(effectiveTheme);
  const flip = () => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); setThemeState(next); };
  return (
    <header className="top">
      <div className="in">
        <div className="brand">
          <svg className="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#3B3FD8" /><path d="M8 10.5A2.5 2.5 0 0 1 10.5 8h11a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5H14l-4 3.5V20a2 2 0 0 1-2-2z" fill="#fff" /><circle cx="22.5" cy="21.5" r="4" fill="#E8743B" /></svg>
          <b>ReMath</b><span className="sub">{t('brandSub')}</span>
        </div>
        {account ?? <div className="acct" />}
        <SegmentedToggle className="ui-seg" ariaLabel={t('uiAria')} value={lang} onChange={setLang} options={[{ value: 'ko', label: '한' }, { value: 'en', label: 'EN' }]} />
        <button type="button" className="btn sm" aria-label={t(theme === 'dark' ? 'themeLight' : 'themeDark')} title={t(theme === 'dark' ? 'themeLight' : 'themeDark')} onClick={flip}>
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </div>
    </header>
  );
}
