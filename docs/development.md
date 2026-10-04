<!-- page: Understand or contribute | 1 | code layout and testing. -->
# Development and dogfooding

## Where a new feature goes

CLI commands in `src/cli/`, routes in `src/server/routes/`, rules in `src/model/`, tables in `src/store/tables/`, views in `web/pages/`, `AGENTS.md` text in `src/repository-setup.ts`, protocol topics in `docs/protocol/`.

`tests/hotspots.test.ts` holds each assembler to a size budget.

## Validate a change

```sh
npm ci && npm run build && npm test
```

`npm test` hides `GRAPHYARD_*`/`HERDR_*`, reserves free Postgres ports. Worktree installs need [bubblewrap](install.md#preconditions).

## CI

`test` aggregates shards balanced by `tests/helpers/timing-baseline.json` (top-level `tests/*.test.ts`); pull requests run affected tests (`scripts/ci-tests.mjs`). Long suites run on [release candidates](github.md#pre-merge-gate-and-release-candidate-validation).

## Documentation

`docs/README.md`, `docs/protocol.md`: generated in full from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`; [`GRAPHYARD_GENERATED_FILES`](coordination.md#generated-files-never-conflict) exempts them from the regression guard. README.md and `docs/` keep `graphyard.json`'s `wordBudget` (12,000 words, 1,200 per page; `tests/docs-budget.test.ts`), one topic per page. A page over its cap fails CI; the total only warns, and at 97% the loop files one trim item.

### Documentation that rarely conflicts

Add self-contained paragraphs; don't reword shared sentences. Candidates conflicting only in `docs/**/*.md` get docs-sync, not rework: base merges in, both sides kept in budget, approval kept if the non-docs diff is unchanged; five conflicts per path in 24 hours raise attention.

## Trusted contracts

Trusted CI runs only protected source, refusing candidates whose base lacks the contract: land harness and `scripts/contracts.mjs` entry before requiring its proof.
