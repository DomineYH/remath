import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Toast } from './components/Toast.tsx';
import { LangProvider } from './i18n/index.tsx';
import { AdminLoginScreen } from './screens/AdminLoginScreen.tsx';
import { AdminAiScreen } from './screens/AdminAiScreen.tsx';
import { AdminGroupsScreen } from './screens/AdminGroupsScreen.tsx';
import { AdminLogsScreen } from './screens/AdminLogsScreen.tsx';
import { AdminScenariosScreen } from './screens/AdminScenariosScreen.tsx';
import { AdminUsersScreen } from './screens/AdminUsersScreen.tsx';
import { ChatScreen } from './screens/ChatScreen.tsx';
import { HistoryScreen } from './screens/HistoryScreen.tsx';
import { LoginScreen } from './screens/LoginScreen.tsx';
import { PracticeHomeScreen } from './screens/PracticeHomeScreen.tsx';
import { LoginGate, RequireRealm } from './session.tsx';

const admin = (el: ReactNode) => <RequireRealm realm="admin">{el}</RequireRealm>;
const teacher = (el: ReactNode) => <RequireRealm realm="teacher">{el}</RequireRealm>;

export function App() {
  return (
    <LangProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LoginGate realm="teacher"><LoginScreen /></LoginGate>} />
          <Route path="/admin" element={<LoginGate realm="admin"><AdminLoginScreen /></LoginGate>} />
          <Route path="/practice" element={teacher(<PracticeHomeScreen />)} />
          <Route path="/practice/history" element={teacher(<HistoryScreen />)} />
          <Route path="/practice/:id" element={teacher(<ChatScreen isAdminTest={false} />)} />
          <Route path="/admin/scenarios" element={admin(<AdminScenariosScreen />)} />
          <Route path="/admin/scenarios/:id/test" element={admin(<ChatScreen isAdminTest />)} />
          <Route path="/admin/users" element={admin(<AdminUsersScreen />)} />
          <Route path="/admin/groups" element={admin(<AdminGroupsScreen />)} />
          <Route path="/admin/logs" element={admin(<AdminLogsScreen />)} />
          <Route path="/admin/ai" element={admin(<AdminAiScreen />)} />
          <Route path="/admin/*" element={<Navigate to="/admin" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toast />
    </LangProvider>
  );
}
