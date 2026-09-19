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
| `src/onboarding.ts`, `src/github-setup.ts` | Repository discovery and local GitHub App registration |
| `scripts/contracts.mjs`, `scripts/*contract*.mjs`, `scripts/*acceptance*.mjs` | Trusted contract registry, protected HTTP harnesses, and separate evidence publisher |
| `scripts/protect-github.mjs`, `scripts/verify-enforcement.mjs` | Bind the App-owned check; inspect live merge enforcement read-only |
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

The tests run isolated Postgres on ports 15438 to 15445 (and 15448 for delegation), with temporary database directories. Override `GRAPHYARD_TEST_PORT` to move the whole range, or a suite's own variable (`GRAPHYARD_VALIDATION_TEST_PORT`, `GRAPHYARD_HERDR_RECOVERY_TEST_PORT`, and so on) individually. Do not point tests at production. Tests start local processes and sockets, so a restricted execution sandbox may require explicit local-network permission. Run as a non-root user; the test runtime does not create system users.

The cross-machine recovery suite shortens the lease and launch fences of its own engine instance, and states those fences when it calls the protected recovery contract, so the contract runs unchanged in seconds. A trusted run passes no such override and refuses any candidate whose fences are shorter than the shipped defaults in `src/engine.ts`; the suite asserts that the certified minimums still match those defaults.

Test behavioral invariants, not implementation details: conflicting claims, stale epochs, replayed requests, missing/skipped/stale evidence, authenticated producer scope, external observation races, and side-effect retries. Keep GitHub calls outside domain transactions. A UI change must not introduce an arbitrary state-write endpoint.

## Bootstrap boundary

Graphyard's initial implementation predates its own control plane and remains bootstrap history. The repository now routes new work through Graphyard-assigned worktrees, current-head Codex review, protected CI, trusted acceptance evidence, and guarded master merges.

The [repository bootstrap guide](first-pr.md) documents Graphyard's protected reporter. Regular PR CI validates packaging without production credentials; only the separate protected workflow may publish trusted acceptance evidence.

## Suggested first dogfooding tasks

1. Secure supervised dispatch and acknowledgment across Herdr hosts.
2. Turnkey execution for pinned E2E scenarios with protected runner identities.
3. Deployment, environment, and production verification observations.
4. API and semantic conflict detection beyond current file/resource overlap.
5. Multi-repository delivery graphs and release coordination.
6. Pagination, archival export, and measured fleet-scale load tests.

Each task should define an observable outcome and trusted proof names before an implementation agent claims it. Do not weaken policy to get the system's own PRs through its gates. A future policy-engine migration needs an explicit bootstrap/recovery procedure under operator control.

## Contributing

Open an issue describing the concrete failure or desired behavior. Include relevant work IDs, refusal reasons, commit IDs, and redacted evidence references. Do not include access tokens or private key material. PRs should explain the resulting behavior and relevant validation, and update docs when protocol or deployment behavior changes.

The repository is Apache-2.0 licensed. Release packaging, a public npm package, and a Kubernetes Helm chart are not yet shipped.
