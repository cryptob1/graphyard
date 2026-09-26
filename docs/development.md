<!-- page: Understand or contribute | 1 | code layout and testing. -->
# Development and dogfooding

## Where a new feature goes

- A CLI command: `src/cli/` (`defineCommands`); an HTTP route: `src/server/routes/` (`defineRoutes`).
- A schema or gate rule: `src/model/` (commands via `src/engine.ts`, GitHub I/O `src/github.ts`).
- A table: `defineTable` in `src/store/tables/`; migrations and backups follow.
- A dashboard view: `web/pages/`, listed in `web/pages/index.tsx`.
- A protocol topic: `docs/protocol/`, starting `<!-- page: Agent protocol | N | summary -->`.
- Managed `AGENTS.md` text: templates in `src/repository-setup.ts` or `src/master.ts`; re-render, commit.

`tests/hotspots.test.ts` holds each assembler to a size budget.

## Validate a change

```sh
npm ci && npm run build && npm test
```

`npm test` hides `GRAPHYARD_*`/`HERDR_*` variables and reserves free Postgres ports.

## Documentation

`docs/README.md` and `docs/protocol.md` are generated in full from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`; never edit them by hand; the regression guard exempts them via `GRAPHYARD_GENERATED_FILES` (what `scripts/check-docs.mjs --list` prints). README.md and `docs/` stay within 12,000 words, no page over 1,200, and each topic lives on one page (`tests/docs-budget.test.ts`): link, never restate.

### Documentation that rarely conflicts

Add a self-contained paragraph or section; reword shared sentences only when wrong. GitHub's conflict reading waits for the control plane's test merge; a confirmed conflict only in `docs/**/*.md` gets a docs-sync session, not rework: it merges the base keeping both meanings in budget, touching only conflicted paragraphs; the approval stays if the diff outside `docs/` is unchanged. `master status` and Insights rank 24-hour conflict hotspots; 5 on one path is raised.

## Trusted contracts

A trusted CI run executes only protected source, refusing a candidate whose base lacks the contract: land the harness and its `scripts/contracts.mjs` entry before requiring its proof.
