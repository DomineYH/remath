// `node --import ./src/raw-hooks.ts`: @remath/prompts 가 Vite식 `*.md?raw` 를 import 하므로 Node에서 같은 뜻(파일 텍스트)으로 읽는다.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, next) {
    if (!url.endsWith('?raw')) return next(url, context);
    const text = readFileSync(new URL(url.slice(0, -'?raw'.length)), 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  },
});
