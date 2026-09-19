<!-- page: Understand or contribute | 2 | repository layout, where new features go, and dogfooding. -->
# Development and dogfooding

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src/model.ts` → `src/model/` | Schemas, domain types and pure gate evaluation, one module per concern behind a barrel |
| `src/store.ts` → `src/store/` | Postgres transactions, immutable events and job leasing; `src/store/tables/` is the schema registry |
| `src/engine.ts` | Authenticated commands, ownership, evidence, reconciliation |
| `src/github.ts` | App authentication, provider observations, check publishing |
| `src/server.ts` → `src/server/` | HTTP authentication and app assembly; `src/server/routes/` holds one route module per resource |
| `src/cli.ts` → `src/cli/` | The launcher; one command module per command group, the help text generated from them |
| `src/onboarding.ts`, `src/github-setup.ts` | Repository discovery and local GitHub App registration |
| `scripts/*acceptance*.mjs` | Protected HTTP contract harness and separate evidence publisher |
| `scripts/protect-github.mjs`, `scripts/verify-enforcement.mjs` | Bind the App-owned check; inspect live merge enforcement read-only |
| `scripts/check-docs.mjs` | Link, anchor and generated-index check for the guides (`npm run docs:check`) |
| `web/main.tsx` → `web/pages/` | The dashboard shell; one page component per view, the sidebar generated from `web/pages/index.tsx` |
| `integrations/herdr/` | Native Herdr ledger pane and open action |
| `tests/` | Real Postgres integration and HTTP tests; `tests/hotspots.test.ts` guards the layout below |
| `docs/` | User, architecture, deployment, protocol, and recovery guides; `docs/protocol/` is one page per protocol topic |

## Where a new feature goes

Every feature used to edit the same six files, so every merge made every other open PR conflict. The files are now thin assemblers over registries, and a feature lands in files of its own:

| Adding | Touch | Never |
| --- | --- | --- |
| A CLI command | One entry in the matching module under `src/cli/` (or a new module exporting `defineCommands([...])`, spread into `commands` in `src/cli/index.ts`). Its `help` lines are the help text; `scope: 'work'` makes the dispatcher resolve the work item first. | Add a branch to `src/cli/index.ts` or `src/cli.ts` |
| An HTTP route | One entry in the resource's module under `src/server/routes/` (or a new module exporting `defineRoutes(...)`, listed in `publicRoutes` or `apiRoutes` in `src/server/index.ts`). Return the JSON body; return `Sent` after writing raw bytes. | Match a path in `src/server/index.ts` or `src/server.ts` |
| A schema, type or gate rule | The concern module under `src/model/` (`policy`, `work`, `evidence`, `review`, `escalation`, `delegation`, `delivery`, `bootstrap`, `gates`, `queue`). Existing imports from `src/model.ts` keep working through the barrel. | Grow `src/model.ts` past its barrel |
| A table | A `defineTable` in the concern's module under `src/store/tables/` (or a new module spread into `tables` in `src/store/schema.ts`). The migration, `ledgerTables`, export order and sequences are derived from it, so a backup can never miss a table. | Hand-edit `migration` or a table list |
| A dashboard view | One page component under `web/pages/` and one entry in `views` in `web/pages/index.tsx`; the sidebar and main pane render from that list. | Add a branch to `web/main.tsx` |
| A protocol topic | One page under `docs/protocol/` with a `<!-- page: Agent protocol \| N \| summary -->` first line, then `npm run docs:check -- --write` to regenerate the index in `docs/protocol.md`. Other guides declare their `docs/README.md` section the same way. | Edit the generated index blocks by hand |

`tests/hotspots.test.ts` enforces this: each assembler has a line and byte size budget, every command, route, table and page module must be reachable from its registry, and the docs indexes must be current. Raise a budget only together with a further split.

## Validate a change

```sh
npm ci
npm run build
npm test
```

The tests run isolated Postgres on port 15438, with a temporary database directory. Override `GRAPHYARD_TEST_PORT` if needed. Do not point tests at production. Tests start local processes and sockets, so a restricted execution sandbox may require explicit local-network permission. Run as a non-root user; the test runtime does not create system users.

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
