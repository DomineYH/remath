# ReMath

Misconception questioning simulator for preservice teachers. Product spec: `prd/`, terms: `GLOSSARY.md`, decisions: `docs/adr/`.

Stage 1 is a client-only app (`client/`) talking to a mock API in the browser. Workspaces: `client`, `shared` (zod API contract), `prompts`, `db/seed`.

## Setup

```sh
nvm use            # Node 24 (.nvmrc)
npm ci
npx playwright install chromium
```

Mock mode (local dev only): put `VITE_MOCK_ADMIN_PASSWORD=<8+ chars, letters and numbers>` in `client/.env.development.local`, then run `npm run dev:mock -w client`. Sign in as admin at `/admin` with ID `admin`. Never deploy a mock build. `client/.env.example` lists the keys.

## Tests

Run all five before a change is done. CI (`.github/workflows/ci.yml`) runs the same commands.

```sh
npm run typecheck     # tsc --noEmit in every workspace
npm run lint          # ESLint (screens may not import the HTTP/mock API; screen copy only through the i18n dict) + lint:env (VITE_MOCK_ADMIN_PASSWORD only inside the mock module)
npm test              # Vitest unit tests: shared contract, Api ↔ route table, turn engine, prompts, review checks, mock API (incl. practice sessions and turns, users·groups, scenario create·review·publish·delete, teacher exposure walk, sessions CSV, AI settings, audit rows)
npm run e2e           # Playwright in mock mode: walking skeleton (signup, admin login, toggles), the admin scenario list, the admin test chat, users·groups → practice → chat → My history → admin Conversations + CSV file, the scenario wizard → publish → group → teacher, AI settings, and the 400×800 smoke (no page-level horizontal scroll, one-line top bar, menus·dropdown·panel by keyboard, dark mode, EN↔한)
npm run check:bundle  # production build has no mock storage key, mock marker or admin password; a mock build has all three
```

### Seam A groups and targets

The API-boundary suites in `client/src/api/mock/*.test.ts` reach the server only through a target from `client/src/api/seam.ts`: `api(realm)` is this browser, `browser()` another browser (own cookie jar) on the same server. The default target is the mock (`mockTarget`); `useTarget(make)` swaps in another one (the HTTP run). Groups named `[mock] …` (`describeMock`) are skipped on an injected target.

| Target | Groups (file) |
|---|---|
| any (HTTP-runnable) | A-1 teacher exposure (exposure) · A-2 practice-session rules, A-2 turn rules, A-3 turn pipeline, A-6 admin state (sessions) · sample scenarios, A-4 create·update·review·publish·delete, A-10 providers (scenarios) · A-5 users, groups, getPractice (admin) · A-5 signup·validation, password change, logout·realms (mock) · A-7 sessions CSV, A-10 AI settings (logs) |
| mock only | A-9 initial state, admin password from env, storage; A-8 audit helper (mock) · A-2 turn rules mid-stream (409 while streaming, dropped stream), A-2 reload, `turnLimit` (sessions) · A-4 stored compiled prompt, `templates` c7 (scenarios) · A-10 stored keys, A-8 audit log (logs) · A-8 user·group rows (admin) · A-8 scenario rows (scenarios) |

HTTP groups assert on `Api` results only: no store reads, and time values (`started_at`, `created_at`, …) only for presence and order. An injected target must be a server seeded like the mock (the five samples), reset between tests, and passes its admin password to `useTarget` (it becomes `ADMIN_PW`).

### HTTP run (`npm run test:http -w server`)

Runs the HTTP-runnable groups above against a real server through `createHttpApi` (T-2). Not part of `npm test` or CI (O-11). Out of scope: A-8 audit (the SQL smoke covers it) and A-9 initial state (the seed smoke covers it); the run prints this too.

```sh
cd server
MOCK_LLM=1 COOKIE_SECURE=false PORT=3946 node --env-file=$HOME/.config/remath/dev.env --import ./src/raw-hooks.ts src/index.ts &   # the server under test
ENV_FILE=$HOME/.config/remath/dev.env SERVER_URL=http://127.0.0.1:3946 npm run test:http
```

- Env: `SERVER_URL`, `DEV_ADMIN_PASSWORD` (the server's admin password, injected as `ADMIN_PW`), `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`. `ENV_FILE` loads them from a file.
- Each browser is a cookie-jar `fetch` (`server/src/test-http/jar.ts`): it keeps `set-cookie` (Path, Max-Age/Expires) and sends the `cookie` header; `browser()` is a new jar; a logout's expired cookie empties it.
- Known state (`server/src/test-http/reset.ts`): **destructive, dev project only.** It refuses to run unless `SUPABASE_URL` contains the dev project ref `ezzufgvulfwygojibujv`. At the start it snapshots the admin password hash, the five samples (`gabriel`, `hajun`, `jiwoo`, `noah`, `seoyeon`) with their translations, and `ai_settings`. Before every test and once at the end it deletes, through the Data API, every teacher (with their sessions, turns, memberships and logins), every session, every group, every non-sample scenario and the audit rows written since the run started, then writes the snapshot back (a changed admin password goes back through `change_password`, which ends every admin login). `schema_migrations` is untouched; no DDL. Never point it at a database whose data you need.

## G2 demo checklist

Mock mode (`npm run dev:mock -w client`, see Setup), in a fresh browser profile. Open `/admin`.

1. Admin login: ID `admin`, the password from `VITE_MOCK_ADMIN_PASSWORD`.
2. Scenarios → "＋ New scenario" → "Fill example (Seoyeon)"; walk the 7 steps (step 6: 7 checks PASS/INFO, tick the 4 confirmations).
3. Step 7 → "Publish". The card shows "Published".
4. Users → "＋ Add user" (nickname + password); Groups → "＋ New group" with that user and the scenario.
5. Sign out, sign in at `/` as that user → pick the student → chat (quick chips, classification toggle, mentor hints) → "End session".
6. The report: leverage bars and the verdict line (no goal or misconception text).
7. "My history" → "View" shows the same report.
8. Admin → Conversations: "View" the transcript, then "Download CSV (n)".
9. Admin → AI settings: key source, model and effort per bot; "Save".
10. Narrow the window to 400px (or DevTools 400×800): no page-level sideways scroll, the ⋯ menu and account dropdown, the internal-state panel folded above the admin test chat; then ☾ (dark) and 한│EN.
