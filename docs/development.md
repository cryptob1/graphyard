<!-- page: Understand or contribute | 1 | code layout and testing. -->
# Development and dogfooding

## Where a new feature goes

- A CLI command: a `src/cli/` module (`defineCommands`); help is generated.
- An HTTP route: a `src/server/routes/` module (`defineRoutes`).
- A schema or gate rule: its module under `src/model/`; commands via `src/engine.ts`, GitHub I/O `src/github.ts`.
- A table: a `defineTable` under `src/store/tables/` (migrations and backups derive).
- A dashboard view: a `web/pages/` page listed in `web/pages/index.tsx`.
- A protocol topic: a `docs/protocol/` page starting `<!-- page: Agent protocol | N | summary -->`.
- Managed `AGENTS.md` text: the template in `src/repository-setup.ts` or `src/master.ts`; re-render `AGENTS.md`.

`tests/hotspots.test.ts` holds each assembler to a size budget.

## Validate a change

```sh
npm ci && npm run build && npm test
```

`npm test` hides `GRAPHYARD_*`/`HERDR_*` variables and reserves free Postgres ports. Worktree installs need [bubblewrap](install.md#preconditions).

Where a sandbox stats `/tmp`, `/home` as uid 65534, attestor tests assert their ownership refusal, noted; `tests/helpers/unprivileged-stat.mjs` simulates this.

## CI

`test` aggregates shards balanced by `tests/helpers/timing-baseline.json` (tracking top-level `tests/*.test.ts`); pull requests run affected tests, `main` and queue tips every pre-merge file (`scripts/ci-tests.mjs`). Long suites run on [release candidates](delivery.md#pre-merge-gate-and-release-candidate-validation).

## Documentation

`docs/README.md` and `docs/protocol.md` are generated in full from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`; `GRAPHYARD_GENERATED_FILES` ([value](coordination.md#generated-files-never-conflict)) exempts them from the regression guard. README.md and `docs/` stay within the `wordBudget` in `graphyard.json` (12,000 words, no page over 1,200), each topic on one page (`tests/docs-budget.test.ts`): link, never restate. A total over the budget never fails CI: the test warns, and `master status` reports the total and the largest pages; a page over its per-page cap still fails. At 97% of the budget, `master status` raises `docs`; the loop files one 5%-headroom trim item.

### Documentation that rarely conflicts

Add a self-contained paragraph or section rather than rewording shared sentences. A candidate whose conflicts with the base are confined to docs/**/*.md is refreshed by docs-sync, not reworked: the base merges in, both sides kept in budget, and approval is kept when the non-docs diff is unchanged; five or more conflicts in 24 hours on one path raises an attention item.

The launcher, which is not confined, creates the docs-sync worktree itself — a detached checkout of the reviewed head at `.graphyard/docs-sync/<KEY>-<head7>` under the coordinator checkout — and starts the session in it. The session's confinement binds the coordinator checkout read-only and then re-binds exactly that worktree and the shared Git directory writable; nothing else in the coordinator checkout is writable. A launch whose worktree is still not writable, on the host or under the confinement, is refused before the session starts, naming the path, and the loop sends the conflict to rework in the same cycle. Each docs-sync launch first removes the docs-sync worktrees no running session owns.

## Trusted contracts

Trusted CI runs only protected source, refusing candidates whose base lacks the contract: land the harness and its `scripts/contracts.mjs` entry first, then require later work's proof.
