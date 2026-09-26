<!-- page: Understand or contribute | 1 | code layout and testing. -->
# Development and dogfooding

## Where a new feature goes

- CLI command: `src/cli/` module (`defineCommands`); help is generated.
- HTTP route: `src/server/routes/` (`defineRoutes`).
- Schema or gate rule: its `src/model/` module; commands run through `src/engine.ts`, GitHub I/O in `src/github.ts`.
- Table: `defineTable` in `src/store/tables/`; migrations and backups derive from it.
- Dashboard view: `web/pages/` page plus an entry in `web/pages/index.tsx`.
- Protocol topic: a `docs/protocol/` page starting `<!-- page: Agent protocol | N | summary -->`.
- Managed `AGENTS.md` text: `src/repository-setup.ts` or `src/master.ts`; re-render and commit.

`tests/hotspots.test.ts` holds each assembler to a size budget.

## Validate a change

```sh
npm ci && npm run build && npm test
```

`npm test` hides `GRAPHYARD_*`/`HERDR_*` variables and reserves free Postgres ports.

## CI

`test` passes when every `test shard N` and `test-browser` passes. Shards balance on `tests/helpers/timing-baseline.json` durations (`scripts/ci-tests.mjs durations` refreshes them). Pull requests run only tests reaching changed files (`ci-tests.mjs affected FILE`); unmapped, dependency, runner or config changes, `main` and queue tips run all.

## Documentation

`docs/README.md` and `docs/protocol.md` are generated in full from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`; never edit them by hand; the regression guard exempts them via `GRAPHYARD_GENERATED_FILES` (what `scripts/check-docs.mjs --list` prints). README.md and `docs/` stay within 12,000 words, no page over 1,200, and each topic lives on one page (`tests/docs-budget.test.ts`): link, never restate.

## Trusted contracts

Trusted CI runs only protected source and refuses a candidate whose base lacks the contract: land the harness and its `scripts/contracts.mjs` entry before requiring its proof.
