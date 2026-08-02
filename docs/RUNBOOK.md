# HPB Operations & Rollback Runbook (spec 16.5)

Day-to-day incident handling for the Hepatobiliary app: how to revert a bad
deploy, triage with logs, restore the seed/clean database state, and read the
load-test output. Applies to both repositories (backend = this repo, frontend =
`hpb-app frontend`).

## 1. Rolling back a bad deploy

1. Find the offending commit(s): `git log --oneline -10` in the repo in question.
2. Revert with a fresh commit (preferred over `reset`, which rewrites shared history):
   - `git revert <sha>` for a single commit, or
   - `git revert <sha1>^..<sha2>` for a contiguous range.
3. Push to `main` — CI runs again and the hosting platform redeploys automatically:
   - `git push origin main`
4. Confirm the deploy is healthy:
   - `curl <base-url>/api/health` → `{"status":"ok","db":"connected",…}`
   - Walk the key screens in the browser.

Both repos are independent deploys — a backend-only regression usually only needs
the backend reverted; a UI regression only the frontend.

## 2. Data-safety guarantees (why most rollbacks are code-only)

- **Append-safe schema.** Writes add fields/documents; nothing is dropped or
  destructively migrated. Reverting code never needs a schema rollback.
- **Unique indexes** protect identity: `users.loginId`, `users.email` (sparse),
  `users.phone` (sparse), `patients.medicalNumber`, `dayTypeCalendar.date`,
  `attendance.{userId,date}`. A re-run of an import/upsert cannot create dupes.
- **Idempotent bulk operations.** `bulkGenerate` and the roster import leave
  existing slots untouched, so re-running after a fix is safe.
- Audit writes are append-only; they are the source of truth for "who changed
  what" (`auditLogs`, `performedBy`, `performedAt`).

## 3. Wiping test/QA data and restoring the canonical state

When a QA pass has written test data, restore to seed + the real admin account:

1. Delete the QA collections directly in MongoDB Atlas (or via a throwaway
   script that connects with `MONGODB_URI`): `shiftAssignments`,
   `dayTypeCalendar`, `emergencyDayPools`, `rosterImports`, `attendance`,
   `shiftKeys`, `auditLogs` — keep `users` minus any test accounts.
2. Re-run the canonical seed to rebuild the rulebook:
   - `npm run seed` (role-slot definitions, case-type templates, lab mappings)
   - `npm run seed:mappings` (lab-test-name mappings) if not covered by `seed`.
3. Verify counts: 1 admin user, 18 role-slot definitions, 3 case-type templates,
   36 lab-test-name mappings, and 0 rows in the QA collections above.

The integration test suite never touches the real database — it runs entirely
inside `mongodb-memory-server` (see `tests/roster-service.integration.test.ts`),
so `npm run test` is always safe against a live environment.

## 4. Incident triage with logs

- **Correlation ID flow:** the frontend sends/reads `x-correlation-id`. The
  backend middleware mint-or-passes it, stamps it on the response, and logs the
  request entry; `handleRoute` closes the loop with status + duration for the
  refactored routes. A user's correlation ID maps 1:1 to the server log lines.
- **Logs are JSON lines:** `ts`, `level`, `event`, `message`, plus fields. The
  `event` values to look for: `http_request` (entry), `http_complete`,
  `http_error` (4xx/5xx with `status`/`durationMs`), `load_test`.
- **Where logs live:** the hosting platform's runtime log stream (e.g. Vercel
  function logs). `console.*` output from API routes/middleware appears there.
- **Slow requests:** search `http_complete` with a large `durationMs`, or
  `http_error` with `status: 500`. Client-reported timeouts → same correlation
  ID in the platform logs.
- **Data-level questions:** query `auditLogs` filtered by `documentId` or
  `performedBy` to reconstruct what changed on an object.

## 5. Load test

- `npm run load-test` fires `LOAD_CONCURRENCY` (default 20) parallel requests at
  `LOAD_URL` (default `/api/health`) for `LOAD_DURATION_MS` (default 5000).
- It fails (exit 1) when p95 > `LOAD_P95_MAX_MS` (default 500) or the error rate
  > `LOAD_ERROR_RATE_MAX` (default 0.02), so it can gate a deploy.
- Example against the roster board:
  ```
  LOAD_TARGET=http://localhost:3001 LOAD_URL=/api/roster/board \
    LOAD_CONCURRENCY=25 LOAD_DURATION_MS=8000 npm run load-test
  ```
  (Needs a running local backend and an auth token is **not** required only for
  `/api/health` — authenticated endpoints need `LOAD_URL` with credentials
  passed through a pre-authenticated session or the endpoint will report 401s.)

## 6. Dependabot / CI health

- Dependabot opens npm bump PRs weekly (max 10, labelled `dependencies`).
  Merge only when the CI badge is green; the integration tests catch breaking
  changes in the rulebook before they reach production.
- If a Dependabot PR turns CI red, either fix the incompatibility or close the
  PR with a note — never merge red.
