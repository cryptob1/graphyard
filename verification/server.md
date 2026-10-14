Paths: src/server/**, src/server.ts

## Tests

- `tests/board-api.test.ts`: the board's HTTP routes and their principals.
- `tests/server-startup-readiness.test.ts`, `tests/healthz-bounded.test.ts`: startup and health.
- `tests/decision-lifecycle.test.ts`, `tests/decision-application.test.ts`: two-party decisions.
- `tests/lease-lifecycle.test.ts`, `tests/server-scale.test.ts`, `tests/server-heap-bounded.test.ts`.

## Drive

`npm run dev` serves `src/server.ts` against `DATABASE_URL`; tests start the server in-process over an embedded Postgres. Read a route with `node bin/graphyard.mjs status GY-N` from a configured checkout rather than hand-written requests.

## Invariants

- Every route authenticates a principal and checks the role the action needs; there is no client-controlled lifecycle-state endpoint.
- Mutations carry the lease epoch they act under and are refused once it is expired or superseded.
- The approver of a decision is never its requester, an implementer of the item, or the producer of its evidence.
- `/healthz` and the coordination snapshot stay bounded in time and size whatever the board's size.

## Gotchas

- New routes live in `src/server/routes/`; `src/server/routes.ts` only wires them.
- A refusal names its reason in the response body; tests match on that text.
- An `Idempotency-Key` makes a retried mutation replay its result; reusing one with different input is refused.
