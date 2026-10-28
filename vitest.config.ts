import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['{shared,client,prompts}/**/*.test.ts', 'db/migrations/*.test.ts'], environment: 'node' },
});
