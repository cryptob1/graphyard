<!-- page: Understand or contribute | 1 | code layout and testing. -->
# Development and dogfooding

## Where a new feature goes

- A CLI command: a `src/cli/` module (`defineCommands`); help is generated.
- An HTTP route: a `src/server/routes/` module (`defineRoutes`).
- A schema or gate rule: its module under `src/model/`; commands via `src/engine.ts`, GitHub I/O `src/github.ts`.
- A table: a `defineTable` under `src/store/tables/` (migrations and backups derive).
- A dashboard view: a `web/pages/` page listed in `web/pages/index.tsx`.
- A protocol topic: a `docs/protocol/` page starting `<!-- page: Agent protocol | N | summary -->`.
- Managed `AGENTS.md` text: the template in `src/repository-setup.ts` or `src/master.ts`; re-render `AGENTS.md`.

`tests/hotspots.test.ts` holds each assembler to a size budget.

## Validate a change

```sh
npm ci && npm run build && npm test
```

`npm test` hides `GRAPHYARD_*`/`HERDR_*` variables and reserves free Postgres ports.

## CI

`test` aggregates shards balanced by `tests/helpers/timing-baseline.json`; pull requests run affected tests, `main` and queue tips all (`scripts/ci-tests.mjs`).

## Documentation

`docs/README.md` and `docs/protocol.md` are generated in full from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`, never by hand; `GRAPHYARD_GENERATED_FILES` ([value](coordination.md#generated-files-never-conflict)) exempts them from the regression guard. README.md and `docs/` stay within 12,000 words, no page over 1,200, each topic on one page (`tests/docs-budget.test.ts`): link, never restate.

## Trusted contracts

Trusted CI runs only protected source, refusing candidates whose base lacks the contract: land the harness and its `scripts/contracts.mjs` entry first, then require later work's proof.
