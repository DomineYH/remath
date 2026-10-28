// Self-test of the A-3 lint boundary: screen code may not import the HTTP or mock implementation, nor call fetch directly.
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();
const rulesHit = async (code: string, filePath = 'client/src/screens/X.tsx') =>
  (await eslint.lintText(code, { filePath }))[0].messages.map(m => m.ruleId);

describe('screen code boundary (A-3, C-11)', () => {
  for (const src of ['../api/mock/index.ts', '../api/http.ts', '../api/mock', '../api/mock/store.ts']) {
    it(`blocks import of ${src}`, async () => expect(await rulesHit(`import '${src}';\n`)).toContain('no-restricted-imports'));
  }
  it('blocks direct fetch and EventSource', async () => {
    expect(await rulesHit(`fetch('/x');\n`)).toContain('no-restricted-globals');
    expect(await rulesHit(`new EventSource('/x');\n`)).toContain('no-restricted-globals');
  });
  it('allows the api index and the per-realm instances', async () => {
    expect(await rulesHit(`import { createApi } from '../api/index.ts';\nimport { teacherApi } from '../apis.ts';\nexport const a = [createApi, teacherApi];\n`)).toEqual([]);
  });
  it('does not apply inside client/src/api', async () => {
    expect(await rulesHit(`import { createHttpApi } from './http.ts';\nexport const a = createHttpApi;\n`, 'client/src/api/index.ts')).toEqual([]);
  });
});
