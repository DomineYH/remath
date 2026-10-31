import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// api/http or api/mock, with any extension (.ts .tsx .js .jsx) or `./` segments in between (A-3, C-11).
const API_IMPL = '(^|/)api/(\\./)*(http|mock)(\\.[jt]sx?|/|$)';
const IMPORT_MSG = 'Screens import only Api/ApiError/createApi from api/index (A-3, C-11).';
const HTTP_MSG = 'HTTP goes through Api (A-3).';
// Screen copy comes from the i18n dict, never a literal (B-9): JSX text, user-facing attributes and {'...'} with a Latin or Hangul letter.
const COPY_MSG = 'Screen copy goes through t() and the i18n dict (B-9).';
const LETTER = '/[A-Za-z가-힣]/';
const COPY = [
  `JSXText[value=${LETTER}]`,
  `JSXAttribute[name.name=/^(aria-label|placeholder|title|alt|label|ariaLabel)$/] > Literal[value=${LETTER}]`,
  `JSXExpressionContainer > Literal[value=${LETTER}]`,
].map(selector => ({ selector, message: COPY_MSG }));

export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-mock/**', 'playwright-report/**', 'test-results/**', 'base_ui/**', '.vercel/**'] },
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
      'no-restricted-imports': ['error', { patterns: [{ regex: API_IMPL, message: IMPORT_MSG }] }],
      'no-restricted-syntax': ['error', { selector: `ImportExpression[source.value=/${API_IMPL.replaceAll('/', '\\/')}/]`, message: IMPORT_MSG }, ...COPY],
      'no-restricted-globals': ['error',
        { name: 'fetch', message: HTTP_MSG },
        { name: 'EventSource', message: HTTP_MSG }],
      'no-restricted-properties': ['error', ...['globalThis', 'window', 'self'].flatMap(object => ['fetch', 'EventSource'].map(property => ({ object, property, message: HTTP_MSG })))],
    },
  },
);
