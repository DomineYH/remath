// 화면 언어 (B-8·B-9): 기본 en, 한│EN 토글, 선택은 브라우저에 따로 보관(remath.ui.lang — 목 저장소 키와 별개).
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api/index.ts';
import { dict, type DictKey } from './dict.ts';

export type Lang = 'ko' | 'en';
export type T = (key: DictKey, arg?: string) => string;
const LANG_KEY = 'remath.ui.lang';

const LangCtx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'en', setLang: () => {} });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem(LANG_KEY) === 'ko' ? 'ko' : 'en'));
  useEffect(() => { localStorage.setItem(LANG_KEY, lang); document.documentElement.lang = lang; }, [lang]);
  return <LangCtx.Provider value={{ lang, setLang }}>{children}</LangCtx.Provider>;
}

export const useLang = () => useContext(LangCtx);

export function useT(): T {
  const { lang } = useLang();
  return (key, arg = '') => { const v = dict[key][lang]; return typeof v === 'function' ? v(arg) : v; };
}

/** ApiError → err.<code> 문구(없으면 err.unknown). 서버 message 는 쓰지 않는다. */
export function errorText(t: T, e: unknown): string {
  const key = `err.${e instanceof ApiError ? e.code : 'unknown'}`;
  return t(key in dict ? (key as DictKey) : 'err.unknown');
}
