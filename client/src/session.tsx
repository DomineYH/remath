// 라우팅 가드 (C-10): /practice/* 는 예비교사 로그인만, /admin/* 는 관리자 로그인만. 로그인 상태로 로그인 화면에 오면 각 홈으로.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import type { ClientRealm } from './api/index.ts';
import { adminApi, teacherApi } from './apis.ts';

type Me = z.infer<typeof S.Me>;
const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx)!;

export const HOME = { teacher: '/practice', admin: '/admin/scenarios' } as const;
export const LOGIN = { teacher: '/', admin: '/admin' } as const;

/** undefined = 확인 중, null = 로그인 안 됨. */
function useWho(realm: ClientRealm): Me | null | undefined {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    (realm === 'admin' ? adminApi.adminMe() : teacherApi.me()).then(m => live && setMe(m), () => live && setMe(null));
    return () => { live = false; };
  }, [realm]);
  return me;
}

export function RequireRealm({ realm, children }: { realm: ClientRealm; children: ReactNode }) {
  const me = useWho(realm);
  if (me === undefined) return null;
  if (me === null) return <Navigate to={LOGIN[realm]} replace />;
  return <MeCtx.Provider value={me}>{children}</MeCtx.Provider>;
}

export function LoginGate({ realm, children }: { realm: ClientRealm; children: ReactNode }) {
  const me = useWho(realm);
  if (me === undefined) return null;
  if (me) return <Navigate to={HOME[realm]} replace />;
  return <>{children}</>;
}
