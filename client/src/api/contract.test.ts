// C-2: route table ↔ Api 1:1, and no teacher-reachable response type carries internal keys (ADR-0003).
import { routes, type Route } from '@remath/shared';
import * as S from '@remath/shared';
import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createHttpApi } from './http.ts';
import { createMockApi } from './mock/index.ts';
import { memoryStorage, seedDb, Store } from './mock/store.ts';
import { API_ROUTES } from './types.ts';

const FORBIDDEN = ['internal', 'compiled_prompt', 'progress', 'counts', 'summary', 'state', 'password', 'password_hash', 'token_hash', 'key_ciphertext'];

/** Walks a zod schema tree collecting object keys (array·nullable·optional·default·union·pipe). SessionReport is skipped by identity: its `summary` is the analysis sentence (D-17), pinned separately below. */
function keys(schema: z.ZodType, out = new Set<string>()): Set<string> {
  if (schema === S.SessionReport) return out;
  const d = (schema as unknown as { def?: Record<string, unknown> }).def;
  if (!d) return out;
  if (d.type === 'object') for (const [k, v] of Object.entries(d.shape as Record<string, z.ZodType>)) { out.add(k); keys(v, out); }
  for (const inner of [d.element, d.innerType, d.in, d.out, d.valueType]) if (inner) keys(inner as z.ZodType, out);
  if (Array.isArray(d.options)) for (const o of d.options) keys(o as z.ZodType, out);
  return out;
}

const routeKey = (r: Route) => `${r.method} ${r.path}`;

describe('C-2 route table ↔ Api', () => {
  it('API_ROUTES values equal the route table, 38 each, no duplicates', () => {
    const table = Object.values(API_ROUTES);
    expect(table).toHaveLength(38);
    expect(new Set(table).size).toBe(38);
    expect([...table].sort()).toEqual(routes.map(routeKey).sort());
  });
  it('HTTP and mock implementations expose exactly the 38 methods', () => {
    const names = Object.keys(API_ROUTES).sort();
    const http = createHttpApi({ realm: 'teacher', fetch: (() => { throw new Error('no network'); }) as typeof fetch });
    const mock = createMockApi({ realm: 'teacher', store: new Store(memoryStorage(), () => seedDb('2026-10-28T00:00:00.000Z')), adminPassword: undefined });
    for (const api of [http, mock]) {
      expect(Object.keys(api).sort()).toEqual(names);
      for (const n of names) expect(typeof (api as unknown as Record<string, unknown>)[n], n).toBe('function');
    }
  });
});

describe('C-2 teacher-reachable responses carry no internal keys', () => {
  it('walker sees nested keys (sanity)', () => {
    expect(keys(S.ScenarioAdmin).has('internal')).toBe(true);
    expect(keys(S.AdminSessionDetail).has('state')).toBe(true);
    expect(keys(S.PracticeHome).has('elicit')).toBe(true);
  });
  for (const r of routes.filter(r => r.realm !== 'admin' && typeof r.response !== 'string')) {
    it(routeKey(r), () => expect([...keys(r.response as z.ZodType)].filter(k => FORBIDDEN.includes(k))).toEqual([]));
  }
  it('SSE events', () => expect([...keys(S.SseEvent)].filter(k => FORBIDDEN.includes(k))).toEqual([]));
  it('SessionReport keys are pinned (its summary is the analysis sentence, D-17)', () => {
    expect(Object.keys(S.SessionReport.shape).sort()).toEqual(['reached', 'rows', 'summary', 'total', 'verdict']);
    expect(keys(S.SessionReport.shape.rows).has('summary')).toBe(false);
  });
});
