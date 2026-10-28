import type { ReactNode } from 'react';

/** 작은 꼬리표. pub = 게시·도달, draft = 경고·초안, lang = 챗봇 언어·할당 시나리오. */
export function Pill({ tone, children }: { tone?: 'pub' | 'draft' | 'lang'; children: ReactNode }) {
  return <span className={tone ? `pill ${tone}` : 'pill'}>{children}</span>;
}
