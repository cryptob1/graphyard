<!-- page: Operate Graphyard | 10 | criteria, overlap and scope. -->
# Coordination

## Write observable criteria

A criterion states an outcome and its proofs:

```json
{"id":"AC-1","text":"Retrying a confirmed booking produces exactly one SMS request","proofs":["integration:sms-idempotency"]}
```

`unit:`/`integration:` proofs are producer-runnable on the exact head ([automatic dispatch](master-agent.md#automatic-dispatch-at-submit)). A `manual:` proof is attested through a two-party decision unless `producerProofs` lists it; judged, not title-counted, its trusted pass proves it whatever it executed (`unit:`/`integration:`/`e2e:` need `executed > 0`). `e2e:` proofs use the [validation runner](validation.md).

## Revise requirements explicitly

`graphyard master requirements GY-N revision.json "REASON"` adds; rewriting, removing or narrowing is a two-party `master decide GY-N requirements @revision.json "REASON"`. A revision replaces the whole document against `expectedPolicyRevision`; stop the worker first (a plannedFiles-only widening excepted), as prior evidence, review and authorization lapse.

## Dispatch optimistically, smallest scope first

`plannedFiles` (paths, or directory prefixes ending `/`) is the change-scope contract, not a lock: the [merge queue](github.md#merge-queue) and `sync` rework integrate overlapping items. `master status` records `overlap.concurrent` and candidates `git merge-tree` cannot merge. A root-level directory is `highConflict`, refused without `--allow-broad-scope`. Only `exclusiveResources`, reserved at claim, hold a dispatch.

Before `worktree GY-N EPOCH` adds the worktree it frees the branch: a rework checkout is detached; an abandoned session worktree under `.graphyard/worktrees` mid-rebase, `am` or bisect is aborted and removed, reported as `reclaimed` in the dispatch record. Dirty, unreadable, leased, or external worktrees are named in errors and left alone; failures carry git stderr. After **3** consecutive single-cause dispatch failures spending an epoch, the loop blocks the item (`dispatchblock`; retried after 5–60 minutes) until `graphyard unblock GY-N REASON`.

## Review gate: verdicts, not threads

The gate is approval of the exact head plus CI; threads are inputs: an approval names each resolved, follow-up (held until shipping, then filed as backlog) or overridden — by thread or comment ID; prose counts for nothing — or is withdrawn, the relaunch naming missed threads for resolution by thread ID. Refusals for reused idempotency keys link that key's item or file under an approval-and-body-hash key. Retries stop after 10 identical 4xx failures, raising attention naming step, error and item. After two rework rounds a bot thread is advisory. Past the review-round cap (default 3) only `BLOCKING:` findings hold a head, escalating rather than reworking ([follow-ups](followups.md#past-the-review-round-cap)). Required conversation resolution is drift: `master protection --apply`.

Each `Follow-up finding:` line ends with its class: `(mechanical: typo|docs-placement|formatting|naming)` or `(substantive: behavior|criteria|scope)`. Any sign of behaviour, a criterion, scope, or unplaceable/pathless finding makes it substantive. `master run` reads approvals once; mechanical findings hold follow-up filing and merge (automatic or not; unclassified reviews hold too), requesting a bot `rework` decision. The worker fixes those findings in one commit on the approved head touching only their files. The fresh read verifies the commit (identity, parent, files), seeing the bot commit, full diff and substantive findings; a refused head returns mechanical findings to the reviewer. `Rejected bot commit: SHA — reason` with REQUEST_CHANGES records a `misclassified-finding` [intervention](dashboard.md). Delivered unchanged, resubmitted at the head, or after the 60-minute hold bound, findings file as follow-ups (`src/mechanical-findings.ts`).

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` also bounds what a candidate may change. At `complete`, on every new head and at landing, files inside scope and new files pass, as do `tests/helpers/timing-baseline.json` lines of tests the change touches; every other file must match the bound base byte-for-byte. A deletion, revert or rewrite is refused, naming the files and their shipping items; carried files (another item's unlanded commits) are no ejection (GY-871). A worker cannot widen `plannedFiles`; a scope request or audited revision can. Asks over 20 files in one directory, or past the 100-entry cap, become their deepest common directory (`tests/`), naming the files covered; pending asks merge into one decision.

One landability verdict, `evaluateLandability` (`src/model/landability.ts`), is the single authority on whether a candidate can land: build and acceptance gates are its refusals, and the merge queue ejects entries only for reasons it gives. Computed from live facts keyed by candidate SHA and policy revision (never stored), each refusal records its version and inputs. Ejections are not sticky: when landable, the head re-enters the queue. The control plane publishes the verdict to GitHub as `graphyard/landable` on every candidate head (GY-887): `success` when landable, `failure` with refusal reasons otherwise, recomputed on each observation and rewritten only when changed. Merge-group, repair-lane and revert heads carry it too; required by protection, it is never an input to the verdict.

### Keep current with `graphyard sync`

The landing check compares changes since merge base with the commit it would land on. Each out-of-scope file is judged by three-way merge onto it, not its blob: extensions or base-only changes merge to the commit version; restoring the merge base is refused. Out-of-scope deletions and rewrites remain refused. Each observation recomputes it, clearing stale refusals without pushing. The simulated-day soak (`tests/soak.test.ts`) runs this check across base moves and stages compare windows without usable merge bases, where false refusals hold only there.

Before any push, `graphyard sync GY-N` merges `origin/BASE` (never a rebase), regenerates, commits and prints the same classification. `graphyard sync GY-N --restore` does the same, then restores every out-of-scope file to the base tip in one new commit whose message names them, so a plain push updates the PR; it never rewrites history, and a force push is never needed or allowed.

### Submit when your own criteria pass

The full suite is CI's gate, not the worker's (GY-853). Workers run the build and `graphyard verify GY-N` (running only their criteria's proofs), submitting when they pass. Any sandbox-only full-suite failure outside `plannedFiles` is named in the PR, not recorded as a blocker. `verify` marks a proof `leftToCi` only when every proof case executed and passed but the run ended abnormally (e.g. file-level hook or signal); `verify` exits 0 and `complete` reports `passing` with the proof left to CI. A failed, skipped or unexecuted case always blocks.

### Generated files never conflict

`docs/README.md` and `docs/protocol.md` are generated in full ([development](development.md)) and `init` renders the managed `AGENTS.md` blocks; `sync` regenerates them after merging. The regression guard classifies `GRAPHYARD_GENERATED_FILES` paths (here `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md`) as `generated`, refusing only a deletion.

## Ship in under thirty minutes

The [routine target](master-agent-reference.md#pipeline-speed) comes from `sync`, automatic dispatch, [proofs in CI](github.md#proofs-in-ci) and conflict avoidance, never weaker gates.

## Explain stalls

`graphyard diagnose GY-N` explains the refusing gate and what else holds it; conflicting `base-behind`/`base-conflict` get rework. Three unobserved observation jobs in a row are `observation-starved`, raised as master attention and `/api/status` `starvedJobs`.
