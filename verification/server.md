Paths: src/server/**, src/server.ts

## Tests

- `tests/board-api.test.ts`: the board's HTTP routes and their principals.
- `tests/production-watch-build-serving.test.ts`: status ignores historical environment/promotion events; the retired route returns 404.
- `tests/delivery-observe-sha.test.ts`: serving-commit observations retain authorization, idempotency, bounded continuation and configured-environment checks.
- `tests/server-startup-readiness.test.ts`, `tests/healthz-bounded.test.ts`: startup and health.
- `tests/master-intent-applies-directly.test.ts`: the master's intent applied at once, and a lapsed lease ending the attempt.
- `tests/lease-lifecycle.test.ts`, `tests/server-scale.test.ts`, `tests/server-heap-bounded.test.ts`.

## Drive

`npm run dev` serves `src/server.ts` against `DATABASE_URL`; tests start the server in-process over an embedded Postgres. Read a route with `node bin/graphyard.mjs status GY-N` from a configured checkout rather than hand-written requests.

For GY-3006, commit, build, then run `graphyard verify GY-3006 --preserves unit:delivery-observe-sha`. Verification binds HEAD. The merge trial serves `graphyard.json`’s isolated server for `e2e:create-work-item`, `e2e:board` and `e2e:work-item-detail`; trusted evidence follows `complete`.

## Invariants

- Every route authenticates a principal and checks the role the action needs; there is no client-controlled lifecycle-state endpoint.
- Mutations carry the lease epoch they act under and are refused once it is expired or superseded.
- `/healthz` and the coordination snapshot stay bounded in time and size whatever the board's size.
- `/api/status` reads production serving state from ProductionWatch and names the environment from process configuration; historical environment and candidate-promotion events do not select it.

## Gotchas

- New routes live in `src/server/routes/`; `src/server/routes.ts` only wires them.
- A refusal names its reason in the response body; tests match on that text.
- An `Idempotency-Key` makes a retried mutation replay its result; reusing one with different input is refused.
