<!-- page: Understand or contribute | 1 | layout, testing. -->
# Development and dogfooding

## Where a new feature goes

CLI `src/cli/`, routes `src/server/routes/`, rules `src/model/`, tables `src/store/tables/`, views `web/pages/`, `AGENTS.md` text `src/repository-setup.ts`, protocol topics `docs/protocol/`; `tests/hotspots.test.ts` holds each assembler to size budget.

## Validate a change

```sh
npm ci && npm run build && npm test
```

`npm test` hides `GRAPHYARD_*`/`HERDR_*`, reserves free Postgres ports; worktrees need [bubblewrap](install.md#preconditions). CI's `test` aggregates shards balanced by `tests/helpers/timing-baseline.json` (top-level `tests/*.test.ts`); PRs run affected tests (`scripts/ci-tests.mjs`); long suites run on [release candidates](delivery.md#pre-merge-gate-and-release-candidate-validation). Trusted CI runs only protected source, refusing candidates whose base lacks contract: land its harness and `scripts/contracts.mjs` entry before requiring its proof.

### Base failures

A required check failing on base head too: no rework, no approver (waiting while base log is unreadable); one attention entry and P0 repair item per failing test and base head. Once base passes, attention clears, failed jobs rerun, blocked candidates get Graphyard-authored base merge (`refresh`) keeping approval. A failure the base tip already passes refreshes at once (trigger `base breakage`).

## Documentation

`docs/README.md`, `docs/protocol.md`: generated in full from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`; [`GRAPHYARD_GENERATED_FILES`](coordination.md#generated-files-never-conflict) exempts them from the regression guard. README.md and `docs/` keep `graphyard.json`'s `wordBudget` (12,000 words, 1,200 per page; `tests/docs-budget.test.ts`), one topic per page: page over cap fails CI, total only warns; at 97% loop files one trim item (keeping every CLI command and HTTP route), never parking on operator.

### Documentation that rarely conflicts

Conflicts only in `docs/**/*.md` get docs-sync, not rework: base merges in keeping both sides; approval stays if non-docs diff holds. A Claude docs-sync session loads only user settings plus its role file (`.graphyard/harness/docs-sync-*.json`, removed when it settles), never master's push deny: it pushes its merge only as `git push origin HEAD:refs/heads/BRANCH`. One already in Herdr is adopted, never relaunched; its hold is the item's recorded wait within the 10-minute blocked bound (attention naming session at half), re-classified on base moves (not docs-only: rework). One stopped 3 minutes unpushed, gone or past its bound wakes its observation, then rework, staying ended if it reappears. On system-driven items that rework is the loop's round, due 10 minutes after the head's conflict is first recorded: docs-sync launches only before a cutoff 2 minutes earlier, stops there, yields once a later observation shows head unmoved, adopting (never reworking) a push landing first. Overdue: `stalled-step` attention (`loop` class) in `master status`; refused hand `master decide GY-N rework` names round and lateness.
