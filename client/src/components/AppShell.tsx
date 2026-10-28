import type { ReactNode } from 'react';
import { TopBar } from './TopBar.tsx';

export function AppShell({ account, subnav, children }: { account?: ReactNode; subnav?: ReactNode; children: ReactNode }) {
  return (
    <>
      <TopBar account={account} />
      <main className="wrap">
        {subnav}
        {children}
      </main>
    </>
  );
}
