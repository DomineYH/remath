# db/seed

Seeds (JSON only) live here. Nothing is seeded in stage 1: the mock API starts with one admin and no teachers, groups or sessions.

When `0001_init.sql` moves from `prototype/db-migration` in stage 2:

- drop `sessions.summary` (ticket 14 — the analysis sentence lives only in `SessionReport.summary`);
- drop `audit_log.updated_at` and its trigger (ticket 20 — audit rows are append-only).
