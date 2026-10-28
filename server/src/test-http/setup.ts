// test:http (#46) setup file: points the seam A suites at the server under test, then resets the dev DB before each test.
import { beforeEach, inject } from 'vitest';
import { createHttpApi } from '../../../client/src/api/http.ts';
import { useTarget, type Factory } from '../../../client/src/api/seam.ts';
import { jarFetch } from './jar.ts';
import { devDb, reset } from './reset.ts';

const base = process.env.SERVER_URL!, db = devDb(process.env);
/** A browser = one cookie jar holding both realm cookies. */
const browser = (): Factory => { const f = jarFetch(); return realm => createHttpApi({ realm, fetch: f, base }); };
useTarget(() => ({ api: browser(), browser }), process.env.DEV_ADMIN_PASSWORD);
beforeEach(() => reset(db, inject('baseline')));
