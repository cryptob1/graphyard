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

`test` aggregates shards balanced by `tests/helpers/timing-baseline.json` (top-level `tests/*.test.ts`); pull requests run affected tests (`scripts/ci-tests.mjs`). Long suites run on [release candidates](delivery.md#pre-merge-gate-and-release-candidate-validation).

### Base failures

A required check failure the base branch head fails too is a base failure: the loop requests no rework and launches no approver (waiting while a base log is unreadable). It raises one attention entry and one P0 repair item per distinct failing test and base head. Once the base check passes again, attention clears, failed jobs rerun, and each blocked candidate is refreshed onto the repaired base by a Graphyard-authored merge of the base into its branch (`refresh`), carrying its approval. A failure whose tests the base tip already passes is not held: the observation refreshes the candidate onto that tip at once (trigger `base breakage`).

## Documentation

`docs/README.md`, `docs/protocol.md`: generated in full from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`; [`GRAPHYARD_GENERATED_FILES`](coordination.md#generated-files-never-conflict) exempts them from the regression guard. README.md and `docs/` keep `graphyard.json`'s `wordBudget` (12,000 words, 1,200 per page; `tests/docs-budget.test.ts`), one topic per page. A page over its cap fails CI; the total only warns, and at 97% the loop files one trim item, which may drop detail but keeps every CLI command and HTTP route named, so it never parks on the operator.

### Documentation that rarely conflicts

Candidates conflicting only in `docs/**/*.md` get docs-sync, not rework: base merges in keeping both sides, and approval stays if the non-docs diff is unchanged. A Claude docs-sync session loads only user settings plus its own role file (`.graphyard/harness/docs-sync-*.json`, removed when the session settles), never the master's push deny: it may push its merge only as `git push origin HEAD:refs/heads/BRANCH`. A docs-sync session already running in Herdr is adopted, never relaunched; its hold is the item's recorded wait, bounded by the 10-minute blocked bound (attention naming the session at half), and is re-classified when the base moves (no longer docs-only: rework); one stopped 3 minutes without pushing, gone or past its bound gets its observation woken and rework next.

## Trusted contracts

Trusted CI runs only protected source, refusing candidates whose base lacks the contract: land harness and `scripts/contracts.mjs` entry before requiring its proof.
