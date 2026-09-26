<!-- page: Understand or contribute | 1 | code layout and testing. -->
# Development and dogfooding

## Where a new feature goes

- A CLI command: a module under `src/cli/` (`defineCommands`); help is generated.
- An HTTP route: a module under `src/server/routes/` (`defineRoutes`).
- A schema or gate rule: its concern module under `src/model/`; commands run through `src/engine.ts`, GitHub I/O in `src/github.ts`.
- A table: a `defineTable` under `src/store/tables/`, from which migrations and backups derive.
- A dashboard view: a page under `web/pages/` plus one entry in `web/pages/index.tsx`.
- A protocol topic: a page under `docs/protocol/` starting `<!-- page: Agent protocol | N | summary -->`.
- Managed `AGENTS.md` text: the template in `src/repository-setup.ts` or `src/master.ts`; re-render and commit `AGENTS.md`.

`tests/hotspots.test.ts` holds each assembler to a size budget.

## Validate a change

```sh
npm ci && npm run build && npm test
```

`npm test` hides `GRAPHYARD_*`/`HERDR_*` variables and reserves free Postgres ports.

## Documentation

`docs/README.md` and `docs/protocol.md` are generated in full from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`; never edit them by hand; the regression guard exempts them via `GRAPHYARD_GENERATED_FILES` (what `scripts/check-docs.mjs --list` prints). README.md and `docs/` stay within 12,000 words, no page over 1,200, each topic on one page (`tests/docs-budget.test.ts`): link, never restate.

### Documentation that rarely conflicts

Add a self-contained paragraph or section; reword shared sentences only when wrong. A conflict the control plane's test merge confirms only in `docs/**/*.md` gets a docs-sync session, not rework: it merges the base keeping both meanings in budget, touching only conflicted paragraphs; the approval stays if the diff outside `docs/` is unchanged. `master status` and Insights rank 24-hour conflict hotspots; 5 on one path is raised.

## Trusted contracts

A trusted CI run executes only protected source, refusing a candidate whose base lacks the contract: land the harness and its `scripts/contracts.mjs` entry first, then require the proof of later work.
