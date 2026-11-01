Paths: src/server/**, src/server.ts

## Tests

- `tests/board-api.test.ts`: the board's HTTP routes and their principals.
- `tests/production-watch-build-serving.test.ts`: `/api/status` reports the watch's serving commit with no production-environment ledger entry, ignores retained environment and candidate-promotion entries, and the retired environment route returns 404 without writing an event.
- `tests/delivery-observe-sha.test.ts`: serving-commit observations retain authorization, idempotency, bounded continuation and configured-environment checks.
- `tests/server-startup-readiness.test.ts`, `tests/healthz-bounded.test.ts`: startup and health.
- `tests/master-intent-applies-directly.test.ts`: the master's intent applied at once, and a lapsed lease ending the attempt.
- `tests/lease-lifecycle.test.ts`, `tests/server-scale.test.ts`, `tests/server-heap-bounded.test.ts`.

## Drive

`npm run dev` serves `src/server.ts` against `DATABASE_URL`; tests start the server in-process over an embedded Postgres. Read a route with `node bin/graphyard.mjs status GY-N` from a configured checkout rather than hand-written requests.

## Invariants

- Every route authenticates a principal and checks the role the action needs; there is no client-controlled lifecycle-state endpoint.
- Mutations carry the lease epoch they act under and are refused once it is expired or superseded.
- `/healthz` and the coordination snapshot stay bounded in time and size whatever the board's size.
- `/api/status` reads production serving state from ProductionWatch and names the environment from process configuration; historical environment and candidate-promotion events do not select it.

## Gotchas

- New routes live in `src/server/routes/`; `src/server/routes.ts` only wires them.
- A refusal names its reason in the response body; tests match on that text.
- An `Idempotency-Key` makes a retried mutation replay its result; reusing one with different input is refused.
