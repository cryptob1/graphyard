Paths: src/server/**, src/server.ts

## Tests

- `tests/signin-session-survives-restart.test.ts`: restart persistence, digest-only storage, expiry and sign-out. Browser case: `e2e/cases/signin-session-survives-restart.json`.
- `tests/board-api.test.ts`: the board's HTTP routes and their principals.
- `tests/production-watch-build-serving.test.ts`: status ignores historical environment/promotion events; the retired route returns 404.
- `tests/delivery-observe-sha.test.ts`: serving-commit observations retain authorization, idempotency, bounded continuation and configured-environment checks.
- `tests/server-startup-readiness.test.ts`, `tests/healthz-bounded.test.ts`: startup and health.
- `tests/master-intent-applies-directly.test.ts`: immediate intent application; lapsed leases end attempts.
- `tests/lease-lifecycle.test.ts`, `tests/server-scale.test.ts`, `tests/server-heap-bounded.test.ts`.

## Drive

`npm run dev` serves against `DATABASE_URL`; tests use embedded Postgres. Read routes with `node bin/graphyard.mjs status GY-N`.

Commit, build, then `graphyard verify GY-N` binds HEAD. The merge trial serves `graphyard.json`’s isolated server for `e2e:create-work-item`, `e2e:board` and `e2e:work-item-detail`; trusted evidence follows `complete`.

## Invariants

- Routes authenticate principals and required roles; no client-controlled lifecycle-state endpoint.
- Mutations carry the lease epoch they act under and are refused once it is expired or superseded.
- `/healthz` and the coordination snapshot stay bounded in time and size whatever the board's size.
- `/api/status` reads production serving state from ProductionWatch and names the environment from process configuration; historical environment and candidate-promotion events do not select it.

## Gotchas

- New routes live in `src/server/routes/`; `src/server/routes.ts` only wires them.
- Refusal responses name their reason; tests match that text.
- `Idempotency-Key` retries replay results; different input is refused.

- Validation runner routes return 404; report import/read/seal and deployment-definition mutations remain. Startup/tick perform no validation reconciliation or artifact expiry. `tests/validation-import-route.test.ts` and `tests/runner-report.test.ts` cover the surviving report path.
