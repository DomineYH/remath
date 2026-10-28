// 테마 (B-7): 저장값이 없으면 OS 설정을 따른다(tokens.css 의 prefers-color-scheme). 선택은 remath.ui.theme 에 따로 보관.
export type Theme = 'light' | 'dark';
const THEME_KEY = 'remath.ui.theme';

export function getTheme(): Theme | null {
  const v = localStorage.getItem(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

export function setTheme(t: Theme) {
  localStorage.setItem(THEME_KEY, t);
  document.documentElement.dataset.theme = t;
}

export const effectiveTheme = (): Theme => getTheme() ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/** 부팅 시 저장값만 적용한다. 없으면 속성을 두지 않아 OS 를 따른다. */
export function applyStoredTheme() {
  const t = getTheme();
  if (t) document.documentElement.dataset.theme = t;
}
