<!-- page: Understand or contribute | 1 | layout, testing. -->
# Development

## Where a new feature goes

- CLI command: a `src/cli/` module (`defineCommands`); help is generated.
- HTTP route: a `src/server/routes/` module (`defineRoutes`).
- Schema or gate rule: its `src/model/` module; commands via `src/engine.ts`, GitHub I/O `src/github.ts`.
- Table: a `defineTable` in `src/store/tables/` (migrations, backups derive).
- Dashboard view: a `web/pages/` page listed in `web/pages/index.tsx`.
- Protocol topic: a `docs/protocol/` page, [page line](#documentation) section `Agent protocol`.
- Managed `AGENTS.md` text: its template in `src/repository-setup.ts` or `src/master.ts`, then re-render.

`tests/hotspots.test.ts` holds each assembler to a size budget.

## Validate a change

```sh
npm ci && npm run build && npm test
```

`npm test` hides `GRAPHYARD_*`/`HERDR_*` variables and reserves free Postgres ports; worktree installs need [bubblewrap](install.md#preconditions). CI's `test` aggregates shards balanced by `tests/helpers/timing-baseline.json`; pull requests run affected tests, `main` and queue tips all (`scripts/ci-tests.mjs`). Trusted CI runs only protected source, refusing candidates whose base lacks the contract: land the harness and its `scripts/contracts.mjs` entry, then require the proof.

## Documentation

`docs/README.md` and `docs/protocol.md` are generated in full from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`; `GRAPHYARD_GENERATED_FILES` ([value](coordination.md#generated-files-never-conflict)) exempts them from the regression guard. README.md and `docs/` share `graphyard.json`'s `wordBudget` (12,000 words, ≤1,200 per page; `tests/docs-budget.test.ts`); one page per topic, link, never restate. A page over its cap fails; an over-budget total only warns, in `master status` with the largest pages; at 97% it raises `docs` and the loop files one 5%-headroom trim item.
