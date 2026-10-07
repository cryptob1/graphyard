<!-- page: Understand or contribute | 1 | layout, testing. -->
# Development and dogfooding

## Where a new feature goes

CLI commands in `src/cli/`, routes in `src/server/routes/`, rules in `src/model/`, tables in `src/store/tables/`, views in `web/pages/`, `AGENTS.md` text in `src/repository-setup.ts`, protocol topics in `docs/protocol/`; `tests/hotspots.test.ts` holds each assembler to a size budget.

## Validate a change

```sh
npm ci && npm run build && npm test
```

`npm test` hides `GRAPHYARD_*`/`HERDR_*` and reserves free Postgres ports; worktrees need [bubblewrap](install.md#preconditions). CI's `test` aggregates shards balanced by `tests/helpers/timing-baseline.json` (`scripts/ci-tests.mjs`); long suites run on [release candidates](delivery.md#pre-merge-gate-and-release-candidate-validation).

### Base failures

A required check the base branch head fails too is a base failure: no rework, one attention entry and one P0 repair item per failing test. Once the base passes, failed jobs rerun and blocked candidates are refreshed onto it, keeping their approval.

## Documentation

`docs/README.md`, `docs/protocol.md`: generated in full from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`; [`GRAPHYARD_GENERATED_FILES`](coordination.md#generated-files-never-conflict) exempts them from the regression guard. README.md and `docs/` keep `graphyard.json`'s `wordBudget` (12,000 words, 1,200 per page; `tests/docs-budget.test.ts`): a page over its cap fails CI, the total only warns, and near it the loop files one trim item that drops detail but keeps every CLI command and HTTP route named.

### Documentation that rarely conflicts

Candidates conflicting only in `docs/**/*.md` get docs-sync, not rework: the base merges in keeping both sides, and approval stays if the non-docs diff is unchanged.

Trusted CI runs only protected source and refuses candidates whose base lacks the contract: land the harness and `scripts/contracts.mjs` entry first.
