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
npm run lint          # ESLint (screens may not import the HTTP/mock API) + lint:env (VITE_MOCK_ADMIN_PASSWORD only inside the mock module)
npm test              # Vitest unit tests: shared contract, Api ↔ route table, turn engine, prompts, review checks, mock API (incl. practice sessions and turns, users·groups, teacher exposure walk, sessions CSV, AI settings, audit rows)
npm run e2e           # Playwright in mock mode: walking skeleton (signup, admin login, toggles), the admin scenario list, the admin test chat, and users·groups → practice → chat → My history → admin Conversations + CSV file, and AI settings
npm run check:bundle  # production build has no mock storage key, mock marker or admin password; a mock build has all three
```
