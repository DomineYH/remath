import { defineConfig } from 'vitest/config';

// Component tests (client/**/*.test.tsx) opt into jsdom per file with `// @vitest-environment jsdom`.
export default defineConfig({
  test: { include: ['{shared,client,prompts,server}/**/*.test.ts', 'client/**/*.test.tsx', 'db/migrations/*.test.ts'], environment: 'node' },
});
