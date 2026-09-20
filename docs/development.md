<!-- page: Understand or contribute | 2 | layout, where features go, dogfooding. -->
# Development and dogfooding

For a contributor: which file a change belongs in, and what the size budget enforces.

## Repository layout

Each path and what it is responsible for:

- `src/model.ts` → `src/model/` — Schemas, domain types and pure gate evaluation, one module per concern behind a barrel
- `src/store.ts` → `src/store/` — Postgres transactions, immutable events and job leasing; `src/store/tables/` is the schema registry
- `src/engine.ts`: Authenticated commands, ownership, evidence, reconciliation
- `src/github.ts`: App authentication, provider observations, check publishing
- `src/validation.ts`, `src/evidence-reuse.ts`, `src/evidence-replay.ts`: The validation runner protocol; reuse policies and decisions; artifact replay and execution analytics
- `src/server.ts` → `src/server/` — HTTP authentication and app assembly; `src/server/routes/` holds one route module per resource
- `src/cli.ts` → `src/cli/` — The launcher; one command module per command group, with the help text generated from them
- `src/onboarding.ts`, `src/github-setup.ts`: Repository discovery and local GitHub App registration
- `scripts/contracts.mjs`, `scripts/*contract*.mjs`, `scripts/*acceptance*.mjs`: Trusted contract registry, protected harnesses, evidence publisher
- `scripts/protect-github.mjs`, `scripts/verify-enforcement.mjs`: Bind the App-owned check; inspect live merge enforcement read-only
- `scripts/check-docs.mjs`, `scripts/docs-budget.mjs`, `scripts/docs-coverage.mjs`, `scripts/docs-duplication.mjs`: Link and anchor checks and the two generated index pages (`npm run docs:check`, `--write`, `--manifest`); the documentation word budget, its documented-surface coverage, and its cross-page duplication report
- `web/main.tsx` → `web/pages/` — The dashboard shell; one page component per view, the sidebar generated from `web/pages/index.tsx`
- `integrations/herdr/`: Native Herdr ledger pane and open action
- `tests/`: Real Postgres integration and HTTP tests; `tests/hotspots.test.ts` guards the layout below
- `docs/`: The guides, the [glossary](glossary.md), and the rendered diagrams under `docs/diagrams/` (regenerate with `node scripts/render-docs-diagrams.mjs`); `docs/protocol/` is one page per protocol topic, and `docs/README.md` and `docs/protocol.md` are generated in full

## Where a new feature goes

Every feature used to edit the same six files, so every merge made every other open pull request conflict.

| Adding | Touch | Never |
| --- | --- | --- |
| A CLI command | One entry in the matching module under `src/cli/` (or a new module exporting `defineCommands([...])`, spread into `commands`). Its `help` lines are the help text; `scope: 'work'` makes the dispatcher resolve the work item first | Add a branch to `src/cli/index.ts` or `src/cli.ts` |
| An HTTP route | One entry in the resource's module under `src/server/routes/` (or a new module exporting `defineRoutes(...)`, listed in `publicRoutes` or `apiRoutes`). Return the JSON body, or `Sent` after writing raw bytes | Match a path in `src/server/index.ts` or `src/server.ts` |
| A schema, type or gate rule | The concern module under `src/model/` (`policy`, `work`, `evidence`, `review`, `escalation`, `delegation`, `delivery`, `bootstrap`, `gates`, `queue`); existing imports keep working through the barrel | Grow `src/model.ts` past its barrel |
| A table | A `defineTable` in the concern's module under `src/store/tables/`. The migration, `ledgerTables`, export order and sequences are derived from it, so a backup can never miss a table | Hand-edit `migration` or a table list |
| A dashboard view | One page component under `web/pages/` and one entry in `views`; the sidebar and main pane render from that list | Add a branch to `web/main.tsx` |
| A protocol topic | One page under `docs/protocol/` with a `<!-- page: Agent protocol \| N \| summary -->` first line, then `npm run docs:check -- --write`. Other guides declare their `docs/README.md` section the same way; both index pages are generated in full, `graphyard sync` regenerates them on a conflict, and the regression guard exempts them once `GRAPHYARD_GENERATED_FILES` is set | Edit a generated index page by hand, or put its path in `plannedFiles` |
| Text in the managed `AGENTS.md` blocks | The template in `src/repository-setup.ts` or `src/master.ts`, then re-render `AGENTS.md` and commit both; a test fails while the committed blocks differ from the templates | Commit an `AGENTS.md` regeneration from another CLI version |

## Validate a change

```sh
npm ci
npm run build
npm test
```

## Bootstrap boundary and contributing

Graphyard's initial implementation predates its own control plane and remains bootstrap history; new work now routes through Graphyard-assigned worktrees, current-head review, protected CI, trusted acceptance evidence and guarded master merges ([repository bootstrap](first-pr.md)). Regular pull-request CI validates packaging without production credentials; only the separate protected workflow may publish trusted acceptance evidence. Suggested dogfooding work — supervised dispatch across Herdr hosts, turnkey E2E execution, production verification observations, semantic conflict detection, multi-repository delivery graphs, pagination, archival export and measured load tests — must define an observable outcome and trusted proof names before a worker claims it, and never weaken policy to get the system's own pull requests through its gates.

