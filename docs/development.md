<!-- page: Understand or contribute | 2 | layout and dogfooding. -->
# Development and dogfooding

For a contributor: which file a change belongs in, and what the size budget enforces.

## Repository layout

| Path | Responsible for |
| --- | --- |
| `src/model.ts` → `src/model/` | Schemas, domain types and pure gate evaluation, one module per concern behind a barrel |
| `src/store.ts` → `src/store/` | Postgres transactions, immutable events and job leasing; `src/store/tables/` is the schema registry |
| `src/engine.ts` | Authenticated commands, ownership, evidence, reconciliation |
| `src/github.ts` | App authentication, provider observations, check publishing |
| `src/validation.ts`, `src/evidence-reuse.ts`, `src/evidence-replay.ts` | The runner protocol; reuse policies and decisions; artifact replay and execution analytics |
| `src/server.ts` → `src/server/` | HTTP authentication and app assembly; `src/server/routes/` is one route module per resource |
| `src/cli.ts` → `src/cli/` | The launcher; one command module per command group, with the help text generated from them |
| `src/onboarding.ts`, `src/github-setup.ts` | Repository discovery and local GitHub App registration |
| `scripts/contracts.mjs`, `scripts/*contract*.mjs`, `scripts/*acceptance*.mjs` | Trusted contract registry, protected harnesses, evidence publisher |
| `scripts/protect-github.mjs`, `scripts/verify-enforcement.mjs` | Bind the App-owned check; inspect live enforcement read-only |
| `scripts/check-docs.mjs`, `scripts/docs-budget.mjs`, `scripts/docs-coverage.mjs`, `scripts/docs-duplication.mjs` | Link, anchor and generated-index checks (`npm run docs:check`, `--write`, `--manifest`); the word budget, documented-surface coverage and cross-page duplication report |
| `web/main.tsx` → `web/pages/` | The dashboard shell; one page component per view, the sidebar generated from `web/pages/index.tsx` |
| `integrations/herdr/` | Native Herdr ledger pane and open action |
| `tests/` | Real Postgres integration and HTTP tests; `tests/hotspots.test.ts` guards the layout below |
| `docs/` | The guides, the [glossary](glossary.md) and the diagrams under `docs/diagrams/` (`node scripts/render-docs-diagrams.mjs`); `docs/protocol/` is one page per topic, and `docs/README.md` and `docs/protocol.md` are generated in full |

## Where a new feature goes

One place per kind of change, so concurrent pull requests stop colliding in the same six files.

| Adding | Touch |
| --- | --- |
| A CLI command | One entry in the matching module under `src/cli/`, or a new module exporting `defineCommands([...])` spread into `commands`; its `help` lines are the help text, and `scope: 'work'` resolves the work item first. Never add a branch to `src/cli/index.ts` |
| An HTTP route | One entry in the resource's module under `src/server/routes/`, or a new module exporting `defineRoutes(...)` listed in `publicRoutes` or `apiRoutes`; return the JSON body, or `Sent` after writing raw bytes. Never match a path in `src/server/index.ts` |
| A schema, type or gate rule | The concern module under `src/model/` (`policy`, `work`, `evidence`, `review`, `escalation`, `delegation`, `delivery`, `bootstrap`, `gates`, `queue`); existing imports keep working through the barrel, which never grows |
| A table | A `defineTable` in the concern's module under `src/store/tables/`; the migration, `ledgerTables`, export order and sequences derive from it, so a backup cannot miss a table and no table list is hand-edited |
| A dashboard view | One page component under `web/pages/` and one entry in `views`, never a branch in `web/main.tsx` |
| A protocol topic | One page under `docs/protocol/` with a `<!-- page: Agent protocol \| N \| summary -->` first line, then `npm run docs:check -- --write`; other guides declare their `docs/README.md` section the same way, and both indexes are `GRAPHYARD_GENERATED_FILES`. Never edit one by hand or put its path in `plannedFiles` |
| Text in the managed `AGENTS.md` blocks | The template in `src/repository-setup.ts` or `src/master.ts`, then re-render and commit both; a test fails while the committed blocks differ, and a regeneration from another CLI version is never committed |

## Validate a change

```sh
npm ci
npm run build
npm test
```

## Bootstrap boundary and contributing

Graphyard's initial implementation predates its own control plane and remains bootstrap history; new work routes through Graphyard-assigned worktrees, current-head review, protected CI, trusted acceptance evidence and guarded merges ([repository bootstrap](first-pr.md)). Regular pull-request CI validates packaging without production credentials, only the protected workflow may publish trusted acceptance evidence, and dogfooding work defines an observable outcome and trusted proof names before a worker claims it.
