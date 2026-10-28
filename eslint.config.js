import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-mock/**', 'playwright-report/**', 'test-results/**', 'base_ui/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }] } },
  { files: ['scripts/**', '*.config.{js,ts}', 'client/vite.config.ts'], languageOptions: { globals: globals.node } },
  {
    files: ['client/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
    languageOptions: { globals: globals.browser },
  },
  {
    // Screens, components and the app shell reach the server only through Api (A-3, C-11).
    files: ['client/src/**/*.{ts,tsx}'],
    ignores: ['client/src/api/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ regex: '(^|/)api/(http|mock)(\\.ts|/|$)', message: 'Screens import only Api/ApiError/createApi from api/index (A-3, C-11).' }] }],
      'no-restricted-globals': ['error',
        { name: 'fetch', message: 'HTTP goes through Api (A-3).' },
        { name: 'EventSource', message: 'HTTP goes through Api (A-3).' }],
    },
  },
);
