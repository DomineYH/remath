// Vercel Build Output API v3 를 직접 만든다(V3, #74 결과). `npm run build:vercel`, vercel.json 의 buildCommand.
//   static/                  = client/dist (CDN, SPA 폴백)
//   functions/api/index.func = server/src/vercel.ts 를 rolldown 으로 묶은 index.mjs + 네이티브 패키지 사본 + .vc-config.json
// `?raw` = 파일 텍스트(Vite·raw-hooks.ts 와 같은 뜻, V5). argon2·better-sqlite3 는 묶지 않고 패키지째 복사한다(linux-x64 prebuilds 포함).
// 빌드는 iad1 에서 돈다: 마이그레이션 같은 네트워크 작업은 넣지 않는다. 크론은 #77·#78 이 config.json 에 더한다.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { rolldown } from 'rolldown';

const OUT = '.vercel/output', FN = `${OUT}/functions/api/index.func`;
const NATIVE = ['argon2', 'better-sqlite3'];
const COPY = ['argon2', '@phc/format', 'node-gyp-build', 'better-sqlite3'];   // 네이티브 패키지와 그 런타임 의존성
const PREBUILDS = ['argon2/prebuilds/linux-x64', 'better-sqlite3/prebuilds/linux-x64.node'];   // Vercel 함수 = linux-x64

const fail = msg => { console.error(`build:vercel failed: ${msg}`); process.exit(1); };
for (const p of COPY) if (!existsSync(`node_modules/${p}/package.json`)) fail(`node_modules/${p} is missing (run npm ci)`);
for (const p of PREBUILDS) if (!existsSync(`node_modules/${p}`)) fail(`node_modules/${p} is missing: the function cannot load the native module`);

rmSync(OUT, { recursive: true, force: true });
execSync('npm run build -w client', { stdio: 'inherit' });
cpSync('client/dist', `${OUT}/static`, { recursive: true });

const raw = {
  name: 'raw',
  resolveId(source, importer) {
    if (!source.endsWith('?raw')) return null;
    return resolve(dirname(importer), source.slice(0, -'?raw'.length)) + '?raw';
  },
  load(id) {
    if (!id.endsWith('?raw')) return null;
    return { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -'?raw'.length), 'utf8'))};`, moduleType: 'js' };
  },
};
const t = Date.now();
const bundle = await rolldown({
  input: 'server/src/vercel.ts', platform: 'node', plugins: [raw],
  external: id => NATIVE.some(n => id === n || id.startsWith(`${n}/`)),
});
await bundle.write({ file: `${FN}/index.mjs`, format: 'esm', codeSplitting: false });
await bundle.close();
console.log(`server bundle ${Date.now() - t}ms`);

for (const p of COPY) cpSync(`node_modules/${p}`, `${FN}/node_modules/${p}`, { recursive: true, dereference: true });
// supportsCancellation: 끊기면 요청을 취소하고 인스턴스를 끝낸다(F-24 미기록). 턴 해제는 턴 경로의 waitUntil 이 지킨다(V7).
writeFileSync(`${FN}/.vc-config.json`, JSON.stringify({
  runtime: 'nodejs24.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false,
  supportsResponseStreaming: true, maxDuration: 300, regions: ['dub1'], supportsCancellation: true,
}, null, 2));
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    { handle: 'filesystem' },
    { src: '^/(api(?:/.*)?|healthz)$', dest: '/api/index' },
    { src: '^/(.*)$', dest: '/index.html' },   // SPA 폴백(정적 파일이 먼저 맞는다)
  ],
}, null, 2));
console.log(`build output ready: ${OUT}`);
