import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Toast } from './components/Toast.tsx';
import { LangProvider } from './i18n/index.tsx';
import { AdminLoginScreen } from './screens/AdminLoginScreen.tsx';
import { AdminPlaceholderScreen } from './screens/AdminPlaceholderScreen.tsx';
import { AdminScenariosScreen } from './screens/AdminScenariosScreen.tsx';
import { LoginScreen } from './screens/LoginScreen.tsx';
import { PracticeHomeScreen } from './screens/PracticeHomeScreen.tsx';
import { LoginGate, RequireRealm } from './session.tsx';

const admin = (el: ReactNode) => <RequireRealm realm="admin">{el}</RequireRealm>;

export function App() {
  return (
    <LangProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LoginGate realm="teacher"><LoginScreen /></LoginGate>} />
          <Route path="/admin" element={<LoginGate realm="admin"><AdminLoginScreen /></LoginGate>} />
          <Route path="/practice" element={<RequireRealm realm="teacher"><PracticeHomeScreen /></RequireRealm>} />
          <Route path="/admin/scenarios" element={admin(<AdminScenariosScreen />)} />
          <Route path="/admin/users" element={admin(<AdminPlaceholderScreen title="tabUsers" />)} />
          <Route path="/admin/groups" element={admin(<AdminPlaceholderScreen title="tabGroups" />)} />
          <Route path="/admin/logs" element={admin(<AdminPlaceholderScreen title="tabLogs" />)} />
          <Route path="/admin/ai" element={admin(<AdminPlaceholderScreen title="tabAI" />)} />
          <Route path="/admin/*" element={<Navigate to="/admin" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toast />
    </LangProvider>
  );
}
