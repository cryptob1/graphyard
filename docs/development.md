<!-- page: Understand or contribute | 1 | code layout and testing. -->
# Development and dogfooding

## Where a new feature goes

CLI commands: `src/cli/`; routes: `src/server/routes/`; rules: `src/model/`; tables: `src/store/tables/`; views: `web/pages/`; `AGENTS.md` text: `src/repository-setup.ts`; protocol topics: `docs/protocol/`.

`tests/hotspots.test.ts` holds each assembler to a size budget.

## Validate a change

```sh
npm ci && npm run build && npm test
```

`npm test` hides `GRAPHYARD_*`/`HERDR_*`, reserves free Postgres ports. Worktree installs need [bubblewrap](install.md#preconditions).

## CI

`test` aggregates shards balanced by `tests/helpers/timing-baseline.json` (top-level `tests/*.test.ts`); pull requests run affected tests (`scripts/ci-tests.mjs`). Long suites run on [release candidates](delivery.md#pre-merge-gate-and-release-candidate-validation).

### Base failures

A required check failure the base head fails too is a base failure: no rework, no approver (waiting while a base log is unreadable); one attention entry and P0 repair item per distinct failing test and base head. Once the base passes, attention clears, failed jobs rerun, and each blocked candidate refreshes onto the repaired base via a Graphyard-authored merge (`refresh`), keeping its approval. A failure the base tip already passes is not held: the candidate refreshes onto that tip at once (trigger `base breakage`).

## Documentation

`docs/README.md`, `docs/protocol.md`: generated in full from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`; [`GRAPHYARD_GENERATED_FILES`](coordination.md#generated-files-never-conflict) exempts them from the regression guard. README.md and `docs/` keep `graphyard.json`'s `wordBudget` (12,000 words, 1,200 per page; `tests/docs-budget.test.ts`), one topic per page. A page over its cap fails CI; the total only warns; at 97% the loop files one trim item.

### Documentation that rarely conflicts

Candidates conflicting only in `docs/**/*.md` get docs-sync, not rework: base merges in keeping both sides; approval stays if the non-docs diff is unchanged.

## Trusted contracts

Trusted CI runs only protected source, refusing candidates whose base lacks the contract: land harness and `scripts/contracts.mjs` entry before requiring its proof.
