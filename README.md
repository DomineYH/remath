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
