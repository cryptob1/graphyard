# Development and dogfooding

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src/model.ts` | Schemas, domain types, pure gate evaluation |
| `src/store.ts` | Postgres schema, transactions, immutable events, job leasing |
| `src/engine.ts` | Authenticated commands, ownership, evidence, reconciliation |
| `src/github.ts` | App authentication, provider observations, check publishing |
| `src/server.ts` | HTTP authentication, validation, webhook, static UI, worker loop |
| `src/cli.ts` | Worker protocol, local worktrees, process supervision |
| `web/` | React graph, board, work form, details and history |
| `integrations/herdr/` | Native Herdr ledger pane and open action |
| `tests/` | Real Postgres integration and HTTP tests |
| `docs/` | User, architecture, deployment, protocol, and recovery guides |

## Validate a change

```sh
npm ci
npm run build
npm test
```

The tests run isolated Postgres on port 15438, with a temporary database directory. Override `GRAPHYARD_TEST_PORT` if needed. Do not point tests at production. Tests start local processes and sockets, so a restricted execution sandbox may require explicit local-network permission. Run as a non-root user; the test runtime does not create system users.

Test behavioral invariants, not implementation details: conflicting claims, stale epochs, replayed requests, missing/skipped/stale evidence, authenticated producer scope, external observation races, and side-effect retries. Keep GitHub calls outside domain transactions. A UI change must not introduce an arbitrary state-write endpoint.

## Bootstrap boundary

The first Graphyard implementation is built by one agent under human supervision. It cannot honestly claim to have governed its own creation. Record the initial code and validation as bootstrap work, then route subsequent work through Graphyard after the control plane, trusted producers, and required GitHub check are connected.

The first fleet acceptance uses Herdr after the MVP. No autonomous multi-agent fleet is part of the bootstrap build.

## Suggested first dogfooding tasks

1. Exercise operator-mediated recovery for blocked and submitted work across real Herdr hosts.
2. A merge broker/queue that narrows the cross-system check-revocation race.
3. Trusted CI inventory reporting with an identity boundary unavailable to PR code.
4. File-overlap warnings from planned paths and provider-observed changes.
5. Herdr dispatch acknowledgment and lifecycle hooks, tested across two machines.
6. Explicit versioned policy edits and requirement-change review.
7. Pagination, normalized evidence/event storage, and load tests for hundreds of workers.
8. Deployment/build/environment observations with staging acceptance.

Each task should define an observable outcome and trusted proof names before an implementation agent claims it. Do not weaken policy to get the system's own PRs through its gates. A future policy-engine migration needs an explicit bootstrap/recovery procedure under operator control.

## Contributing

Open an issue describing the concrete failure or desired behavior. Include relevant work IDs, refusal reasons, commit IDs, and redacted evidence references. Do not include access tokens or private key material. PRs should explain the resulting behavior and relevant validation, and update docs when protocol or deployment behavior changes.

The repository is Apache-2.0 licensed. Release packaging, a public npm package, and a Kubernetes Helm chart are not yet shipped.
