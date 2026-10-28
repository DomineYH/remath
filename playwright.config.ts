import { defineConfig, devices } from '@playwright/test';

// E2E_PORT lets parallel worktrees run E2E side by side.
const port = Number(process.env.E2E_PORT ?? 5180);

// E2E runs the client in mock mode (no server in stage 1). A fresh browser context = an empty remath.mock.v1 store.
export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -w client -- --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    env: { VITE_MOCK_API: '1', VITE_MOCK_ADMIN_PASSWORD: 'E2eAdmin123' },
  },
});
