Paths: src/server/**, src/server.ts

## Tests

- `tests/signin-session-survives-restart.test.ts`: restart persistence, digest-only storage, expiry and sign-out; its `…-stable` case runs the browser case five times in a row, every run passing (GY-3134: the browser case's route bridge answers a down control plane as a refused connection, its waits cover a loaded host's first render, and the disposable sign-in server cuts connections on stop instead of waiting out a slow in-flight request). Browser case: `e2e/cases/signin-session-survives-restart.json`.
- `tests/board-api.test.ts`: the board's HTTP routes and their principals.
- `tests/production-watch-build-serving.test.ts`: status ignores historical environment/promotion events; the retired route returns 404.
- `tests/delivery-observe-sha.test.ts`: serving-commit observations retain authorization, idempotency, bounded continuation and configured-environment checks.
- `tests/server-startup-readiness.test.ts`, `tests/healthz-bounded.test.ts`: startup and health.
- `tests/master-intent-applies-directly.test.ts`: immediate intent and expired leases.
- `tests/lease-lifecycle.test.ts`, `tests/server-scale.test.ts`, `tests/server-heap-bounded.test.ts`.

## Drive

`npm run dev` serves against `DATABASE_URL`; tests use embedded Postgres. `graphyard status GY-N` reads work.

After committing and building, `graphyard verify GY-N` checks HEAD. The merge trial serves the core create, board and detail E2E cases; trusted evidence follows `complete`.

## Invariants

- Routes authenticate principals and authorize roles; no client-controlled lifecycle-state endpoint.
- Mutations carry the lease epoch they act under and are refused once it is expired or superseded.
- `/healthz` and the coordination snapshot stay bounded in time and size whatever the board's size.
- `/api/status` reads production serving state from ProductionWatch and names the environment from process configuration; historical environment and candidate-promotion events do not select it.

## Gotchas

- New routes live in `src/server/routes/`; `src/server/routes.ts` only wires them.
- Refusal responses name their reason; tests match that text.
- An `Idempotency-Key` makes a retried mutation replay its result; reusing one with different input is refused.

- Validation runner routes return 404; external report import/read/seal and deployment-definition mutations remain. Startup and ticks perform no validation reconciliation or artifact expiry. `tests/validation-import-route.test.ts` and `tests/runner-report.test.ts` cover reports.
