// test:http (#46) global setup: checks the env, snapshots what reset() restores once per run, and resets once more at the end.
import type { TestProject } from 'vitest/node';
import { devDb, reset, snapshot, type Baseline } from './reset.ts';

declare module 'vitest' { export interface ProvidedContext { baseline: Baseline } }

export default async function setup(project: TestProject) {
  for (const k of ['SERVER_URL', 'DEV_ADMIN_PASSWORD']) if (!process.env[k]) throw new Error(`test:http needs ${k} (see README › Tests › HTTP run)`);
  const db = devDb(process.env);
  await fetch(process.env.SERVER_URL!).catch(() => { throw new Error(`test:http: no server at SERVER_URL=${process.env.SERVER_URL}`); });
  const baseline = await snapshot(db);
  project.provide('baseline', baseline);
  console.log('test:http runs the seam A HTTP groups only. Out of scope here: A-8 audit (SQL smoke) and A-9 initial state (seed smoke), T-2.');
  return () => reset(db, baseline);
}
