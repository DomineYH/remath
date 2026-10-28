// Production bundle check (A-4, A-5): a build without VITE_MOCK_API must contain no mock storage key, no mock module marker and
// no inlined admin password. A positive-control mock build must contain all three, so the check cannot pass vacuously.
// The env *name* VITE_MOCK_ADMIN_PASSWORD is never searched in bundles (Vite inlines the value); `npm run lint:env` guards the name in source.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PROBE = 'bundleProbe9x';
const NEEDLES = ['remath.mock.v1', 'remath-mock-api::do-not-deploy', PROBE];
const client = new URL('../client/', import.meta.url).pathname;

function build(outDir, mock) {
  const env = { ...process.env, VITE_MOCK_ADMIN_PASSWORD: PROBE };
  delete env.VITE_MOCK_API;
  if (mock) env.VITE_MOCK_API = '1';
  rmSync(join(client, outDir), { recursive: true, force: true });
  execFileSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], { cwd: client, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const files = readdirSync(join(client, outDir), { recursive: true, withFileTypes: true }).filter(f => f.isFile());
  return files.map(f => ({ name: join(outDir, join(f.parentPath ?? f.path, f.name).slice(join(client, outDir).length)), text: readFileSync(join(f.parentPath ?? f.path, f.name), 'latin1') }));
}

const found = files => NEEDLES.map(n => ({ n, in: files.filter(f => f.text.includes(n)).map(f => f.name) }));
let ok = true;

for (const { n, in: hits } of found(build('dist', false))) {
  if (hits.length) { ok = false; console.error(`FAIL prod build contains ${JSON.stringify(n)} in ${hits.join(', ')}`); }
  else console.log(`ok   prod build has no ${JSON.stringify(n)}`);
}
for (const { n, in: hits } of found(build('dist-mock', true))) {
  if (!hits.length) { ok = false; console.error(`FAIL control (mock) build lacks ${JSON.stringify(n)} — the check would be vacuous`); }
  else console.log(`ok   control build has ${JSON.stringify(n)} (${hits.join(', ')})`);
}
process.exit(ok ? 0 : 1);
