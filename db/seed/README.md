# db/seed

Seeds (JSON only) live here. The stage-1 mock API and the stage-2 server seed (`--with-samples`) import the same files (H-38).

- `scenarios/{gabriel,noah,jiwoo,hajun,seoyeon}.json` — the five sample scenarios, `ScenarioInput` shape (both language editions). Gabriel, Noah, Jiwoo and Hajun are the mockup `SEED` + `EN`; Seoyeon is the mockup wizard `EXAMPLE` + `EN.seoyeon` and is the source of "Fill with example". Hajun has no classification criteria (analysis skipped).
- `classification.json` — the default classification set, `{ko, en}`, each `{leverage, object}`.
- `emoji-presets.json` — student 13 (animals) and mentor 8 (objects), each `{emoji, ko, en}` (D-22).

The mock starts with one admin plus these five samples published; no teachers, groups or sessions. `providers.json` is not a seed: it lives in `shared/` (ticket 18).

When `0001_init.sql` moves from `prototype/db-migration` in stage 2:

- drop `sessions.summary` (ticket 14 — the analysis sentence lives only in `SessionReport.summary`);
- drop `audit_log.updated_at` and its trigger (ticket 20 — audit rows are append-only).
