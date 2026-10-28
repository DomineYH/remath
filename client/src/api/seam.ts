// Seam A target (#21 seam A, #35 T-2): the suites in mock/*.test.ts reach the server only through a Target.
// HTTP groups: setup(t = target()) and assert on Api results only — no store, no exact now (time values: presence and order).
// Mock-only groups (describeMock): setup(mockTarget({...})) and may read t.store or inject now·turnLimit·templates.
// Lives outside mock/ on purpose: the mock folder goes away with the server, this seam stays for the HTTP run (#46).
import { describe } from 'vitest';
import type { Jar } from './mock/context.ts';
import { createMockApi, type MockOptions } from './mock/index.ts';
import { memoryStorage, seedDb, Store } from './mock/store.ts';
import type { Api, ClientRealm } from './types.ts';

export const T0 = '2026-10-28T00:00:00.000Z';
/** The admin password of the target under test: the mock's, or the one useTarget injects for a server (a live binding). */
export let ADMIN_PW = 'Admin1234';

export type Factory = (realm: ClientRealm) => Api;
/** One freshly seeded server. `api` = this browser (both realm cookies in one jar); `browser()` = another browser on the same server. */
export interface Target { api: Factory; browser: () => Factory }

/** The stage-1 configuration: a new memory store seeded at T0, now = T0, admin password ADMIN_PW; a browser = its own cookie jar. */
export function mockTarget(o: Partial<MockOptions> = {}): Target & { store: Store } {
  const store = o.store ?? new Store(memoryStorage(), () => seedDb(T0));
  const at = (cookies?: Jar): Factory => realm => createMockApi({ now: () => T0, adminPassword: ADMIN_PW, ...o, realm, store, cookies });
  return { store, api: at(), browser: () => at({ teacher: null, admin: null }) };
}

let injected: (() => Target) | undefined;
/** #46's HTTP setup file calls this before the suites load (and resets the server between tests), with that server's admin password. `undefined` = back to the mock. */
export const useTarget = (make: (() => Target) | undefined, adminPassword = 'Admin1234') => { injected = make; ADMIN_PW = adminPassword; };
/** The target of an HTTP group: the injected one, else the mock with this suite's mock options. */
export const target = (mock?: Partial<MockOptions>): Target => injected?.() ?? mockTarget(mock);
/** A group that only the mock can run: store reads, now·turnLimit·templates injection, A-8 audit, A-9 initial state. Skipped on an injected target. */
export const describeMock = (name: string, fn: () => void) => describe.skipIf(injected !== undefined)(`[mock] ${name}`, fn);
