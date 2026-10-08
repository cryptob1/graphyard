<!-- page: Understand or contribute | 1 | layout, testing. -->
# Development and dogfooding

## Where a new feature goes

CLI `src/cli/`, routes `src/server/routes/`, rules `src/model/`, tables `src/store/tables/`, views `web/pages/`, `AGENTS.md` text `src/repository-setup.ts`, protocol topics `docs/protocol/`; `tests/hotspots.test.ts` holds each assembler to size budget.

## Validate a change

```sh
npm ci && npm run build && npm test
```

`npm test` hides `GRAPHYARD_*`/`HERDR_*`, reserves free Postgres ports; worktrees need [bubblewrap](install.md#preconditions). CI's `test` aggregates shards balanced by `tests/helpers/timing-baseline.json` (top-level `tests/*.test.ts`); PRs run affected tests (`scripts/ci-tests.mjs`); long suites run on [release candidates](delivery.md#pre-merge-gate-and-release-candidate-validation). Trusted CI runs only protected source, refusing candidates whose base lacks contract: land its harness and `scripts/contracts.mjs` entry before requiring its proof.

### Verification maps

`verification/AREA.md` maps (store, server, master): a `Paths:` line of globs, then `## Tests`, `## Drive`, `## Invariants`, `## Gotchas`, ≤250 words each, outside the docs budget (`tests/verification-maps.test.ts`). Worker and reviewer requests inline, after the project-memory digest, maps whose globs cover plannedFiles, read from origin/BASE: workers all four sections, reviewers Invariants and Gotchas; ≤3 maps, 600 words. Add one when an area's tests or invariants keep being rediscovered.

### Base failures

A required check failing on base head too: no rework (waiting while base log is unreadable); one attention entry, P0 repair item per failing test and base head. Once base passes, failed jobs rerun and blocked candidates get a Graphyard base merge (`refresh`) keeping approval; a failure the base tip already passes refreshes at once (trigger `base breakage`).

## Documentation

`docs/README.md`, `docs/protocol.md`: generated in full from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`; [`GRAPHYARD_GENERATED_FILES`](coordination.md#generated-files-never-conflict) exempts them from the regression guard. README.md and `docs/` keep `graphyard.json`'s `wordBudget` (16,000 words, 1,200 per page; `tests/docs-budget.test.ts`), one topic per page: page over cap fails CI, total only warns; at 97% loop files one trim item (keeping every CLI command and HTTP route), never parking on operator.

### Documentation that rarely conflicts

Conflicts only in `docs/**/*.md` get docs-sync, not rework: base merges in keeping both sides; approval stays if non-docs diff holds. A Claude docs-sync session loads only user settings plus its role file (`.graphyard/harness/docs-sync-*.json`), never master's push deny; it pushes only `git push origin HEAD:refs/heads/BRANCH`. One already in Herdr is adopted, never relaunched; it waits within the 10-minute blocked bound, re-classified on base moves (not docs-only: rework). One stopped 3 minutes unpushed, gone or past its bound is reworked. On system-driven items that rework is loop's round, due 10 minutes after the head's conflict is first recorded; docs-sync launches only until 2 minutes before, and a push landing first is adopted. Overdue: `stalled-step` attention (`loop` class) in `master status`; refused hand `master decide GY-N rework` names round and lateness.

### Known hotspot: src/interventions.ts

`src/interventions.ts` only re-exports per-concern modules under `src/interventions/` (`tests/interventions-hotspot-split.test.ts` budgets each). Items touching it or this page append a self-contained paragraph or rule (one `src/interventions/fold-rules.ts` entry per ledger kind), never rewording shared sentences.
