<!-- page: Understand or contribute | 2 | layout, dogfooding. -->
# Development and dogfooding

For a contributor: which file a change belongs in, and what the size budget enforces.

## Repository layout

- `src/store.ts` → `src/store/`: Postgres transactions, immutable events and job leasing; `src/store/tables/` is the schema registry
- `src/engine.ts`: Authenticated commands, ownership, evidence, reconciliation
- `src/github.ts`: App authentication, provider observations, check publishing
- `src/validation.ts`, `src/evidence-reuse.ts`, `src/evidence-replay.ts`: Runner protocol; reuse policies and decisions; artifact replay and execution analytics
- `src/onboarding.ts`, `src/github-setup.ts`: Repository discovery and local GitHub App registration
- `scripts/contracts.mjs`, `scripts/*contract*.mjs`, `scripts/*acceptance*.mjs`: Trusted contract registry, protected harnesses, evidence publisher
- `scripts/protect-github.mjs`, `scripts/verify-enforcement.mjs`: Bind the App-owned check; inspect live enforcement read-only
- `web/main.tsx` → `web/pages/`: Dashboard shell; one page component per view, sidebar generated from `web/pages/index.tsx`
- `integrations/herdr/`: Native Herdr ledger pane and open action
- `tests/`: Real Postgres integration and HTTP tests; `tests/hotspots.test.ts` guards the layout below

## Where a new feature goes

One place per kind of change.

- **A CLI command:** one entry in the matching module under `src/cli/`, or a new module exporting `defineCommands([...])` spread into `commands`; its `help` lines are the help text, `scope: 'work'` resolves the work item first. Never branch in `src/cli/index.ts`
- **An HTTP route:** one entry in the resource's module under `src/server/routes/`, or a new module exporting `defineRoutes(...)` listed in `publicRoutes` or `apiRoutes`; return the JSON body, or `Sent` after writing raw bytes. Never match a path in `src/server/index.ts`
- **A schema, type or gate rule:** concern module under `src/model/` (`policy`, `work`, `evidence`, `review`, `escalation`, `delegation`, `delivery`, `bootstrap`, `gates`, `queue`); imports keep working through the barrel, which never grows
- **A table:** `defineTable` in the concern's module under `src/store/tables/`; migration, `ledgerTables`, export order and sequences derive from it, and no table list is hand-edited
- **Text in the managed `AGENTS.md` blocks:** template in `src/repository-setup.ts` or `src/master.ts`, then re-render and commit both; a test fails while the committed blocks differ, and a regeneration from another CLI version is never committed

## Validate a change

```sh
npm ci
npm run build
npm test
```

- **Isolation:** each suite starts a disposable Postgres on its own offset from `GRAPHYARD_TEST_PORT` (default 15438), which moves the range; one suite moves with its own variable (`GRAPHYARD_VALIDATION_TEST_PORT`, `GRAPHYARD_EVENTS_TEST_PORT`, …); give each parallel worktree a distinct value; never point tests at production. No verdict may depend on which file the scheduler started first, and the suite refuses any two test files sharing a port under the required check's environment.

### Assertions about elapsed time

Some assertions in the required `test` check measure real time — the 2 s p95 of the coordination snapshot, the dispatcher's recovery after a failed read, a cycle inside its interval. Their budgets are real, but a shared runner can miss one with no defect in the candidate, so every such assertion goes through `tests/helpers/timing.ts`.

- **A failure is a `[timing-dependent]` assertion error** naming the measured value against the budget, and the `test` job annotates its own check run with it and with how many other tests failed. The annotation changes no verdict: the check stays failed and the test gate refused until a run passes. `master status` reads those annotations, so the row's `refusal` and `attention` name the measurement rather than *Required CI check test has not passed* — the master's one command is the job rerun (`gh api --method POST repos/OWNER/REPO/actions/jobs/ID/rerun`), once; a second measurement over budget is a regression to return with `master decide GY-N rework REASON`, and a run with other failures offers no rerun because those are the worker's.
- **No behavioural test may depend on how long the runner took** between engine calls: a case needing a merge instant, an execution window or a clock offset pins it to the instants the engine recorded (`tests/helpers/merge-instants.ts`).
- **Stability is measured, not assumed:** `npx tsx tests/helpers/timing-stability.ts [--record tests/helpers/timing-baseline.json]` runs the check twenty times on the same commit, refuses to call it stable if any run failed or the tree changed, and records each assertion's run-to-run spread. `manual:suite-stability-twenty-runs` reads that output, the committed baseline is what a future regression is judged against, and the suite refuses a timing-dependent assertion whose spread was never recorded. Where `/tmp` is under a quota, point `TMPDIR` at a sticky directory outside it.

## Bootstrap boundary and contributing

- The initial implementation predates the control plane as bootstrap history; new work routes through Graphyard-assigned worktrees, current-head review, protected CI, trusted acceptance evidence and guarded merges ([repository bootstrap](first-pr.md))
- Regular pull-request CI validates packaging without production credentials, and only the protected workflow may publish trusted acceptance evidence
