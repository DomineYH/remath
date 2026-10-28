// Self-test of the A-3 lint boundary: screen code may not import the HTTP or mock implementation, nor call fetch directly.
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();
const rulesHit = async (code: string, filePath = 'client/src/screens/X.tsx') =>
  (await eslint.lintText(code, { filePath }))[0].messages.map(m => m.ruleId);

describe('screen code boundary (A-3, C-11)', () => {
  for (const src of ['../api/mock/index.ts', '../api/http.ts', '../api/mock', '../api/mock/store.ts', '../api/http.js', '../api/http.tsx', '../api/http.jsx', '../api/./http.ts', '../api/./mock/index.ts', '../api/mock/index.js']) {
    it(`blocks import of ${src}`, async () => expect(await rulesHit(`import '${src}';\n`)).toContain('no-restricted-imports'));
  }
  it('blocks direct fetch and EventSource', async () => {
    expect(await rulesHit(`fetch('/x');\n`)).toContain('no-restricted-globals');
    expect(await rulesHit(`new EventSource('/x');\n`)).toContain('no-restricted-globals');
  });
  for (const src of ['../api/mock/index.ts', '../api/http.ts', '../api/./mock', '../api/http.js']) {
    it(`blocks dynamic import of ${src}`, async () => expect(await rulesHit(`export const m = await import('${src}');\n`)).toContain('no-restricted-syntax'));
  }
  for (const obj of ['globalThis', 'window']) {
    it(`blocks ${obj}.fetch and ${obj}.EventSource`, async () => {
      expect(await rulesHit(`${obj}.fetch('/x');\n`)).toContain('no-restricted-properties');
      expect(await rulesHit(`new ${obj}.EventSource('/x');\n`)).toContain('no-restricted-properties');
    });
  }
  it('allows the api index and the per-realm instances', async () => {
    expect(await rulesHit(`import { createApi } from '../api/index.ts';\nimport { teacherApi } from '../apis.ts';\nexport const a = [createApi, teacherApi];\n`)).toEqual([]);
    expect(await rulesHit(`export const m = await import('../api/index.ts');\n`)).toEqual([]);
  });
  it('does not apply inside client/src/api', async () => {
    expect(await rulesHit(`import { createHttpApi } from './http.ts';\nexport const a = createHttpApi;\n`, 'client/src/api/index.ts')).toEqual([]);
  });
});

describe('screen copy comes from the i18n dict (B-9)', () => {
  for (const code of ['export const X = () => <p>Save</p>;', 'export const X = () => <p>저장</p>;', 'export const X = () => <input aria-label="Name" />;', 'export const X = () => <input placeholder="이름" />;', "export const X = () => <b>{'Done'}</b>;"]) {
    it(`flags ${code.slice(22)}`, async () => expect(await rulesHit(`${code}\n`, 'client/src/components/X.tsx')).toContain('no-restricted-syntax'));
  }
  it('allows dict text, symbols and markup', async () => {
    expect(await rulesHit(`import { useT } from '../i18n/index.tsx';\nexport const X = () => { const t = useT(); return <p aria-label={t('save')} className="a b">{t('save')} · ⋯ ☾ 1/2 ✓</p>; };\n`, 'client/src/components/X.tsx')).toEqual([]);
  });
});
