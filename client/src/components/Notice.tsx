import type { ReactNode } from 'react';

export function Notice({ tone, children }: { tone: 'ok' | 'warn' | 'info'; children: ReactNode }) {
  return <div className={`notice ${tone}`}>{children}</div>;
}
