import { defineConfig, devices } from '@playwright/test';

// E2E runs the client in mock mode (no server in stage 1). A fresh browser context = an empty remath.mock.v1 store.
export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://localhost:5180', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -w client -- --port 5180 --strictPort',
    url: 'http://localhost:5180',
    reuseExistingServer: !process.env.CI,
    env: { VITE_MOCK_API: '1', VITE_MOCK_ADMIN_PASSWORD: 'E2eAdmin123' },
  },
});
