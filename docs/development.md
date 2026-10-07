<!-- page: Understand or contribute | 1 | layout, testing. -->
# Development and dogfooding

## Where a new feature goes

CLI in `src/cli/`, routes in `src/server/routes/`, rules in `src/model/`, tables in `src/store/tables/`, views in `web/pages/`, `AGENTS.md` text in `src/repository-setup.ts`, protocol topics in `docs/protocol/`; `tests/hotspots.test.ts` holds each assembler to size budget.

## Validate a change

```sh
npm ci && npm run build && npm test
```

`npm test` hides `GRAPHYARD_*`/`HERDR_*`, reserves free Postgres ports; worktrees need [bubblewrap](install.md#preconditions). CI's `test` aggregates shards balanced by `tests/helpers/timing-baseline.json` (top-level `tests/*.test.ts`); PRs run affected tests (`scripts/ci-tests.mjs`); long suites run on [release candidates](delivery.md#pre-merge-gate-and-release-candidate-validation). Trusted CI runs only protected source, refusing candidates whose base lacks contract: land its harness and `scripts/contracts.mjs` entry before requiring its proof.

### Base failures

A required check failing on the base head too: no rework, no approver (waiting while base log is unreadable); one attention entry and P0 repair item per failing test and base head. Once base passes, attention clears, failed jobs rerun, blocked candidates get a Graphyard-authored base merge (`refresh`) keeping approval. A failure the base tip already passes refreshes at once (trigger `base breakage`).

## Documentation

`docs/README.md`, `docs/protocol.md`: generated in full from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`; [`GRAPHYARD_GENERATED_FILES`](coordination.md#generated-files-never-conflict) exempts them from the regression guard. README.md and `docs/` keep `graphyard.json`'s `wordBudget` (12,000 words, 1,200 per page; `tests/docs-budget.test.ts`), one topic per page: a page over cap fails CI, total only warns; at 97% the loop files one trim item (keeping every CLI command and HTTP route), never parking on the operator.

### Documentation that rarely conflicts

Conflicts only in `docs/**/*.md` get docs-sync, not rework: the base merges in keeping both sides; approval stays if non-docs diff holds.
