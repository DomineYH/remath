// test:http (#46): puts the DEV database back to a known state before every test. Coordinator-authorized, dev only, no DDL.
// Kept: the admin row (its password hash restored), the five samples with their translations (restored), ai_settings (restored), schema_migrations.
// Wiped: teachers (→ their sessions, turns, memberships, logins), every session, groups, non-sample scenarios, audit rows written since the run began.
import { createDb, must, type Db } from '../db.ts';

const DEV_REF = 'ezzufgvulfwygojibujv';
/** The mock's seed order (client/src/api/mock/store.ts SAMPLES): its list sorts by updated_at desc and keeps this order on its T0 tie. */
const SAMPLES = ['gabriel', 'noah', 'jiwoo', 'hajun', 'seoyeon'];
type Row = Record<string, unknown>;
export interface Baseline { at: string; adminId: string; adminHash: string; ai: Row[]; scenarios: Row[]; translations: Row[] }

/** The Data API client, only for the dev project: this run deletes rows. */
export function devDb(env: NodeJS.ProcessEnv): Db {
  if (!env.SUPABASE_URL?.includes(DEV_REF) || !env.SUPABASE_SERVICE_KEY)
    throw new Error(`test:http wipes database rows: it runs only with SUPABASE_URL of the dev project (${DEV_REF}) and SUPABASE_SERVICE_KEY`);
  return createDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
}

/** The pre-run values that reset() restores. */
export async function snapshot(db: Db): Promise<Baseline> {
  const at = new Date().toISOString();
  const admin = must(await db.from('users').select('id, password_hash').eq('role', 'admin').single()) as { id: string; password_hash: string };
  const scenarios = must(await db.from('scenarios').select('*').in('slug', SAMPLES)) as Row[];
  if (scenarios.length !== SAMPLES.length) throw new Error(`test:http needs the five seeded samples (${SAMPLES.join(', ')}); run npm run db:seed -w server -- --with-samples`);
  const translations = must(await db.from('scenario_translations').select('*').in('scenario_id', scenarios.map(s => s.id as string))) as Row[];
  return { at, adminId: admin.id, adminHash: admin.password_hash, ai: must(await db.from('ai_settings').select('*')) as Row[], scenarios, translations };
}

/** updated_at of each sample after our last restore, in SAMPLES order; per test file (vitest isolates modules). */
let restored = '';

export async function reset(db: Db, b: Baseline) {
  must(await db.from('sessions').delete().not('id', 'is', null));   // sessions → scenarios is on delete restrict
  const done = async (q: PromiseLike<{ data: unknown; error: unknown }>) => must(await q);
  const [admin, samples] = await Promise.all([
    done(db.from('users').select('password_hash').eq('id', b.adminId).single()) as Promise<{ password_hash: string }>,
    done(db.from('scenarios').select('slug, updated_at').in('slug', SAMPLES)) as Promise<{ slug: string; updated_at: string }[]>,
    done(db.from('users').delete().neq('role', 'admin')),
    done(db.from('groups').delete().not('id', 'is', null)),
    done(db.from('audit_log').delete().gte('created_at', b.at)),
    done(db.from('scenarios').delete().not('slug', 'in', `(${SAMPLES.join(',')})`)),
    done(db.from('ai_settings').upsert(b.ai)),
  ]);
  const at = (rows: { slug: string; updated_at: string }[]) => JSON.stringify(SAMPLES.map(slug => rows.find(r => r.slug === slug)?.updated_at));
  if (at(samples) !== restored) {
    // A test wrote or deleted a sample. Restore all five, one by one in reverse seed order: the update trigger stamps updated_at,
    // so the list (updated_at desc) shows them in the mock's order.
    for (const slug of [...SAMPLES].reverse()) must(await db.from('scenarios').upsert(b.scenarios.find(r => r.slug === slug)!));
    must(await db.from('scenario_translations').upsert(b.translations, { onConflict: 'scenario_id,lang' }));
    restored = at(must(await db.from('scenarios').select('slug, updated_at').in('slug', SAMPLES)) as { slug: string; updated_at: string }[]);
  }
  // A suite changed the admin password: put the old hash back through 0002 change_password (unconditional, ends every admin login).
  if (admin.password_hash !== b.adminHash)
    must(await db.rpc('change_password', { p_user_id: b.adminId, p_expected_hash: null, p_new_hash: b.adminHash, p_keep_token_hash: null }));
}
