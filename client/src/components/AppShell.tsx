import type { ReactNode } from 'react';
import { useHomePath } from '../session.tsx';
import { TopBar } from './TopBar.tsx';

export function AppShell({ account, subnav, children }: { account?: ReactNode; subnav?: ReactNode; children: ReactNode }) {
  const homeTo = useHomePath();
  return (
    <>
      <TopBar homeTo={homeTo} account={account} />
      <main className="wrap">
        {subnav}
        {children}
      </main>
    </>
  );
}
