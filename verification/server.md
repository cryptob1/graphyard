Paths: src/server/**, src/server.ts

## Tests

- `tests/signin-session-survives-restart.test.ts`: restart persistence, digest-only storage, expiry and sign-out. Browser case: `e2e/cases/signin-session-survives-restart.json`.
- `tests/board-api.test.ts`: HTTP routes and principals.
- `tests/production-watch-build-serving.test.ts`: status ignores historical environment/promotion events; the retired route returns 404.
- `tests/delivery-observe-sha.test.ts`: serving-commit observations retain authorization, idempotency, bounded continuation and configured-environment checks.
- `tests/server-startup-readiness.test.ts`, `tests/healthz-bounded.test.ts`: startup and health.
- `tests/master-intent-applies-directly.test.ts`: immediate intent application; lapsed leases end attempts.
- `tests/lease-lifecycle.test.ts`, `tests/server-scale.test.ts`, `tests/server-heap-bounded.test.ts`.

## Drive

`npm run dev` serves `src/server.ts` against `DATABASE_URL`; tests use embedded Postgres. Read with `node bin/graphyard.mjs status GY-N`.

Commit, build, then `graphyard verify GY-3018` (binds HEAD). The merge trial serves `graphyard.json`’s isolated server for `e2e:create-work-item`, `e2e:board` and `e2e:work-item-detail`; trusted evidence follows `complete`.

## Invariants

- Routes authenticate principals and check roles; no arbitrary lifecycle-state endpoint.
- Mutations reject expired or superseded lease epochs.
- `/healthz` and coordination snapshots stay bounded in time and size.
- `/api/status` reads production serving state from ProductionWatch and names the environment from process configuration; historical environment and candidate-promotion events do not select it.

## Gotchas

- New routes live in `src/server/routes/`; `src/server/routes.ts` only wires them.
- Refusal responses name their reason; tests match that text.
- An `Idempotency-Key` makes a retried mutation replay its result; reusing one with different input is refused.

- Validation runner routes return 404; external report import/read/seal and deployment-definition mutations remain. The server startup and tick perform no validation reconciliation or artifact expiry. `tests/validation-import-route.test.ts` and `tests/runner-report.test.ts` cover the surviving report path.
