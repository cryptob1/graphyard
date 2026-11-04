<!-- page: Understand or contribute | 1 | change code and validate -->
# Development and dogfooding

Typechecking enforces `noUnusedLocals` across source, web, and tests. Remove unused imports and bindings; retain setup calls and other side effects when discarding a result.

## Where a new feature goes

| Concern | Source |
| --- | --- |
| CLI | `src/cli/` |
| HTTP routes | `src/server/routes/` |
| Domain rules | `src/model/` |
| Persistence | `src/store/tables/` |
| Dashboard | `web/pages/` |
| Generated AGENTS.md block | `src/repository-setup.ts` |
| Protocol guides | `docs/protocol/` |

Every runtime import in `src/model/` stays within that directory, including library imports. Zod schemas, hashing, configuration loaders and the operations that need them live in `src/model-boundary/`; model references to their inferred types are type-only. The `src/model.ts` facade exports both layers for consumers. Pass the caller's clock explicitly through gate evaluation, evidence selection, dispatch and proof previews. `tests/model-purity.test.ts` checks this boundary and evidence expiry. Schema generations live in `src/store/schema-lineage.ts`.

Claim work and use its assigned worktree before editing ([AGENTS.md](../AGENTS.md)).

Keep runtime helpers below launch and coordination modules: environment-file parsing in `src/env-file.ts`, test-host detection in `src/runtime-environment.ts`, private file I/O in `src/private-file.ts`, loop-code readings in `src/loop-code.ts`, and review wording in `src/review-prompt.ts`. Daemon schemas live beside state, separate from cycle execution. `tests/import-cycles.test.ts` counts static imports, re-exports and literal dynamic imports, excluding type-only edges; no runtime component may exceed three modules.

## Validate a change

```sh
npm run build
node "$GRAPHYARD_CLI" verify GY-N
```

Install dependencies with `npm ci` only when needed; assigned worktrees may share the exact lockfile's install. Domain/API changes also require `npm test`. CI owns the full-suite gate; own-criterion failures always block. Tests use a temporary real Postgres database and `temporaryDirectory(label[, parent])` from `tests/helpers/temp-dirs.ts`. Worker hosts need [bubblewrap](install.md#preconditions).

Worker storage moves: `integration:worker-reparenting` in `tests/worker-filesystem-isolation.test.ts` reproduces the old Landlock `EXDEV` for cache publication, hardlinks and a real local Git push, then exercises the fix inside the ordinary worker mounts and socket domain. `e2e/cases/worker-reparenting.json` runs it with the existing home and socket denials; `e2e:worker-reparenting` runs that bound case in the private-root trial container. Run `npm run build` and full `npm test`. If inherited worker Landlock prevents nested mounts, commit a clean HEAD for operator container placement; standalone filesystem checks do not satisfy this regression.

`tests/architecture.test.ts` enforces the Git network module allowlist and the ban on GitHub API calls. Keep behavioral regressions with their module tests; deleted-file inventories, resolution tables and module line budgets do not belong in the suite.

Vite keeps its dependency optimizer cache in ignored `.graphyard/vite`, outside read-only shared `node_modules`. `tests/vite-private-cache.test.ts` uses the actual project config in the native private root: the previous cache location must fail with `EROFS`, then cold and warm starts serve client, entry and optimized dependency output. `e2e:vite-private-cache` runs that bound regression. Run it, the existing browser suite and full tests in the native trial; inherited worker mount restrictions are not a substitute for that placement.

### Verification maps

`verification/AREA.md` maps source globs in `Paths:` to `## Tests`, `## Drive`, `## Invariants` and `## Gotchas`. Keep each map at most 250 words. Read the relevant map before changing its area.

### Base failures

When a trial's failure also occurs on base, the writer holds the head on one attention entry naming the test; it does not request head rework. It retries the current tip after 30 minutes. The master diagnoses and advances a repair.

Runtime launch tests must also work with an isolated `HOME`/XDG home and durable scratch nested under another home. Its symlinked `.claude/settings.json` is then an ancestor project source, not the session account home. The role harness checks ancestors just as folder trust does and uses `--setting-sources user` with its role file; it never trusts that ancestor. Reproduce with credential-free fixtures in owned scratch (`tests/isolated-trial-runtime-config.test.ts`), not the operator’s real configuration. Project settings still require exclusion or existing trust.

The packed-ref sandbox regression resolves installed Codex from PATH past mise shims without loading operator mise configuration. Detection and sandbox execution use that same executable; verify this test through deployed `rerunTrialFiles` so it starts under the mandatory recheck’s already allocated HOME/XDG directories.

For this regression, also run `tests/trial-merge.test.ts`, `tests/redeploy-herdr-instance.test.ts`, `tests/master-loop-resilience.test.ts` and `tests/launch-prompt-delivery.test.ts` in both the normal shell (with owned HOME/scratch overrides when the sandbox makes the account home read-only) and a child built with `trialEnvironment` plus `trialHomeVariables`. Use a long owned session HOME and disk-backed scratch below a fixture operator home with `.claude/settings.json`; set all three temporary-directory variables to that scratch. Never reuse or delete the caller’s HOME. Direct Claude launch fixtures must explicitly exclude project sources. Harness checks must account for ancestor settings before adding their own project fixture. Herdr persistence tests use a short owned home because isolated trial homes can exceed its 107-byte socket-path bound. Trial-root selection uses fixture filesystem entries to exercise clean and poisoned ancestors independently of host lookup entries; reclamation tests verify the exact session fallback when the real fixture ancestry is poisoned.

The private-root image installs locked Chromium at `/opt/graphyard-browsers`; container trials keep that read-only asset path while HOME, XDG caches, profiles and scratch belong to the allocation. Outside the image, pre-submit rechecks retain an allocated browser cache. The trial image declares its installed browser path for direct suite launches, and dashboard trials use it without downloading into the read-only image. The canonical trial environment replaces inherited `LANG` and `LC_*` with `LANG=C.UTF-8` and `LC_ALL=C.UTF-8`, available in the image; the host's locale stays unchanged. This also covers service managers whose unsupported host locale lacks an interactive shell's `LC_ALL` override. `tests/private-root-trial-assets.test.ts` reproduces native initdb's unsupported-locale failure, starts real Postgres through that canonical environment, reproduces the empty-home cache failure, renders with the installed browser, and checks the embedded-Postgres package's `native/pg-symlinks.json` links. Missing native links require the package's own postinstall (`npm rebuild @embedded-postgres/linux-x64` on Linux x64) in the installed dependency tree before making it read-only; no system ICU replacement is needed.

Run `node --import tsx tests/helpers/run-tests.ts tests/private-root-trial-assets.test.ts tests/complete-owned-recheck-scratch.test.ts tests/coordinator-os-confinement.test.ts tests/action-claim-observation.test.ts` in the actual outer trial container, then `npm test` there. The bound `e2e:private-root-trial-assets` case runs the same regressions. Each private-root wrapper binds only a fresh, sticky disk-backed directory from its managed allocation at `/var/tmp`; it never exposes host `/var/tmp` or substitutes tmpfs for durable managed checkouts. The trial image includes ripgrep for launch-discovery fixtures and Debian trixie's Git for `merge-tree --merge-base`. Namespace fixtures create their own control endpoints and verify masks; scratch checks assert ownership and writability without assuming different filesystem devices. Failure summaries retain each test name and its first assertion or child stderr independently of long invocations and stacks, sharing the bounded log budget across failures. These runs supplement the required exact-head tests, E2E and merge gates.

Canonical checkouts can reuse identical-lockfile dependencies through a `node_modules` symlink. Nested trials retain that link from the checkout bind and mount its real dependency tree read-only; binding onto the already visible symlink makes bubblewrap fail. External dependency aliases and harness mounts remain explicit. `tests/trial-container.test.ts` reproduces the exact symlink mount error, then checks a real nested launch, dependency resolution, read-only dependencies and writable checkout, profile and scratch. Run it and `tests/worker-filesystem-isolation-e2e.test.ts` in the actual outer container as well.

Command E2E failures extract the failing test name and first error from fully redacted output before truncation, falling back to the final line when neither is present. The bounded reason and 50-line record retain those diagnostics alongside the output tail, so long trailing stacks cannot hide a native startup error. Exit status and timeout handling stay unchanged.

### Golden eval

`eval/golden/` has ten fixed items with criteria/proofs and scaffold archives under 1 MB, covering delivery and recovery cases.

Run before and after dispatch, brief, session or merge-trial changes. This consumes fleet time and is outside `npm test`:

```sh
node --import tsx scripts/eval-golden.ts --release SHA --runs 2 --repo OWNER/SCRATCH-REPO --port 4390
node --import tsx scripts/eval-golden.ts --compare eval/results/OLD.json eval/results/NEW.json
```

Use the release's checkout, one release at a time. Each run creates/removes a scratch Compose install with its own port and Herdr; start its loop. It waits `--bound-minutes` (90) per item. `eval/results/SHA.json` records outcomes, attempts, rework and claim-to-Done time; comparison names changed rows before totals.

## Documentation

Edit handwritten guides and their `<!-- page: Section | order | summary -->` metadata. `npm run docs:check -- --write` generates `docs/README.md` and `docs/protocol.md`; `npm run docs:check` validates relative links and anchors. The [generated-file policy](coordination.md#generated-files) keeps sync from hand-merging indexes.

Diagram specs live in `scripts/render-docs-diagrams.mjs`. The opening video has a separate HTML source and renderer under `scripts/walkthrough/`; [rendering instructions](walkthrough.md) cover both committed media assets.

Mutation bookkeeping lives in `src/store/mutations.ts`: call `once(db, actor, key, input, fn)` inside the existing transaction and locks. It fingerprints input, replays the recorded result and refuses changed input with HTTP 409. `record` appends history. Use `appendEvidence(work, evidence, db)` from `src/model-boundary/append-evidence.ts` to append evidence and its scenario run together. External I/O stays outside the transaction; receipt preflight reads never replace the transactional check.

Schema generation 13 retires job holds and their status fields, the unused work-index owner, epoch and next-action columns, and the legacy merger pin and production observation tables. Startup migrates existing databases and rebuilds the work index; fresh databases omit those fields. Repeating the migration skips column removal when the index projection is unchanged, so live writers do not block startup. Job scheduling still uses wake generations, due times and lease tokens.

