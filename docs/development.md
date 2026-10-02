<!-- page: Understand or contribute | 1 | code layout and testing. -->
# Development and dogfooding

## Where a new feature goes

- CLI command: `src/cli/` module (`defineCommands`), generated help.
- HTTP route: `src/server/routes/` module (`defineRoutes`).
- Schema or gate rule: `src/model/`; commands via `src/engine.ts`, GitHub I/O `src/github.ts`.
- Table: `defineTable` in `src/store/tables/` (migrations, backups derive).
- Dashboard view: `web/pages/` page listed in `index.tsx`.
- Protocol topic: `docs/protocol/` page starting `<!-- page: Agent protocol | N | summary -->`.
- Managed `AGENTS.md` text: `src/repository-setup.ts` or `src/master.ts` templates; re-render.

`tests/hotspots.test.ts` holds each assembler to a size budget.

## Validate a change

```sh
npm ci && npm run build && npm test
```

`npm test` hides `GRAPHYARD_*`/`HERDR_*`, reserves free Postgres ports. Worktree installs need [bubblewrap](install.md#preconditions).

## CI

`test` aggregates shards balanced by `tests/helpers/timing-baseline.json`; pull requests run affected tests, `main` and queue tips every pre-merge file (`scripts/ci-tests.mjs`). Long suites run on [release candidates](github.md#pre-merge-gate-and-release-candidate-validation).

## Documentation

`docs/README.md`, `docs/protocol.md`: generated in full from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`; [`GRAPHYARD_GENERATED_FILES`](coordination.md#generated-files-never-conflict) exempts them from the regression guard. README.md and `docs/` keep `graphyard.json`'s `wordBudget` (12,000 words, 1,200 per page; `tests/docs-budget.test.ts`), one topic per page: link, never restate. Page over cap fails CI; total over only warns (`master status`: total, largest pages); at 97% `docs` is raised and the loop files one 5%-headroom trim item.

## Trusted contracts

Trusted CI runs only protected source, refusing candidates whose base lacks the contract: land harness and `scripts/contracts.mjs` entry before requiring its proof.
