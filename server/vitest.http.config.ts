// `npm run test:http -w server` (#46, T-2): the seam A suites against a running server. Not part of `npm test` or CI (O-11).
import { defineConfig } from 'vitest/config';

if (process.env.ENV_FILE) process.loadEnvFile(process.env.ENV_FILE);

export default defineConfig({
  test: {
    root: '..',
    include: ['client/src/api/mock/*.test.ts', 'server/src/test-http/*.http.ts'],   // [mock] groups skip themselves once the target is injected; *.http.ts = server-only cases
    environment: 'node',
    globalSetup: ['server/src/test-http/global.ts'],
    setupFiles: ['server/src/test-http/setup.ts'],
    fileParallelism: false,   // one server, one database: reset() before each test
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
