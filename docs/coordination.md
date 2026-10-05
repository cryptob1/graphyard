<!-- page: Operate Graphyard | 10 | criteria, overlap and scope. -->
# Coordination

## Write observable criteria

A criterion states an outcome and its proofs:

```json
{"id":"AC-1","text":"Retrying a confirmed booking produces exactly one SMS request","proofs":["integration:sms-idempotency"]}
```

`unit:`/`integration:` proofs are producer-runnable on the exact head ([automatic dispatch](master-agent.md#automatic-dispatch-at-submit)). A `manual:` proof is attested through a two-party decision unless `producerProofs` lists it; judged, not title-counted, its trusted pass proves it whatever it executed (`unit:`/`integration:`/`e2e:` need `executed > 0`). `e2e:` proofs use the [validation runner](validation.md).

## Revise requirements explicitly

`graphyard master requirements GY-N revision.json "REASON"` adds; rewriting, removing or narrowing is a two-party `master decide GY-N requirements @revision.json "REASON"`. A revision replaces the document against `expectedPolicyRevision`; stop the worker first, plannedFiles-only widenings excepted: prior evidence, review and authorization lapse.

## Dispatch optimistically, smallest scope first

`plannedFiles` (paths, or directory prefixes ending `/`) is the change-scope contract, not a lock: the [merge queue](github.md#merge-queue) and `sync` rework integrate overlapping items. `master status` records `overlap.concurrent` and candidates `git merge-tree` cannot merge. A root-level directory is `highConflict`, refused without `--allow-broad-scope`. Only `exclusiveResources`, reserved at claim, hold a dispatch.

Before `worktree GY-N EPOCH` adds the worktree it frees the branch: an earlier attempt's session worktree holding it (checked out, or mid-rebase, merge, cherry-pick or revert) has its refs, uncommitted diff and untracked contents recorded as `workspace.preserved`, the operation ended and HEAD detached; the branch never moves. An abandoned session worktree of the item under `.graphyard/worktrees` mid-`am` or bisect is aborted and removed, reported as `reclaimed` (a dirty or unreadable one is named and left). A holder under a live lease, or one outside that directory, is named in the error and left alone. Every failure carries git's stderr; a workspace failure releases the claim without spending the epoch or cooling the profile. After **3** consecutive dispatch failures of one item with one cause (workspace failures included), the loop records it as the blocker (`dispatchblock`; a refusal is retried after 5 minutes, doubling to an hour) and stops dispatching until `graphyard unblock GY-N REASON`.

## Review gate: verdicts, not threads

The gate is the reviewer's approval of the exact head plus required CI; threads are inputs: an approval names each listed one resolved, follow-up (held on the item until it ships, then filed as backlog) or overridden — by its thread ID or a comment ID the prompt shows beside it; prose counts for nothing — or is withdrawn, and the relaunch's prompt names the threads it missed; the loop resolves those named, always by thread ID. A filing refused as a reused idempotency key links that key's item (same parent and approval), or files under an approval-and-body-hash key. Retries stop after 10 consecutive identical 4xx failures, raising one attention item naming step, error and item. After two rework rounds a bot's thread is advisory. Past the review-round cap (default 3) only a `BLOCKING:` finding holds a head, and it escalates rather than reworks ([follow-ups](followups.md#past-the-review-round-cap)). Required conversation resolution is drift: `master protection --apply`.

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` also bounds what a candidate may change. At `complete`, on every new head and at landing, files inside scope and new files pass, as do `tests/helpers/timing-baseline.json` lines of top-level tests (`tests/*.test.ts`) the change touches; every other file must match the bound base byte-for-byte. A deletion, revert or rewrite is refused, naming the files and their shipping items; carried files (another item's unlanded commits) are no ejection (GY-871). A worker cannot widen `plannedFiles`; a scope request or audited revision can. Asks over 20 files in one directory, or past the 100-entry cap, become their deepest common directory (`tests/`), naming the files covered; pending asks merge into one decision.

One landability verdict, `evaluateLandability` (`src/model/landability.ts`), is the single authority on whether a candidate can land: the build and acceptance gates are its refusals, and the merge queue ejects an entry only for a reason it gives. It is computed from live facts keyed by candidate SHA and policy revision, never stored; each refusal records its version and inputs on the gate and the ejection. Its ejections are not sticky: a head re-enters the queue once landable. The control plane publishes the verdict to GitHub as one check run, `graphyard/landable`, on every candidate head (GY-887): `success` when landable, `failure` with every refusal reason as its summary otherwise, recomputed on each observation (head, check, review, evidence, policy) and rewritten only on change. Merge-group, repair-lane and revert heads carry it too. Required by protection, it is still never an input to the verdict it reports.

### Keep current with `graphyard sync`

The landing check compares the candidate's changes since its merge base with the commit it would land on (live or predicted). Each out-of-scope file is judged by the head's three-way merge onto it, not its blob: a change the commit has since extended, or one only the base made, merges to the commit's version, while a head restoring the merge-base version over it is refused. Out-of-scope deletions and rewrites remain refused. Each observation recomputes it, so stale refusals clear without a push. The simulated-day soak (`tests/soak.test.ts`) runs this check across landing-base moves and a window where GitHub compares lack a usable merge base; its false refusals hold only there.

Before any push, `graphyard sync GY-N` merges `origin/BASE` (never a rebase), regenerates, commits and prints the same classification. `graphyard sync GY-N --restore` does the same, then restores every out-of-scope file to the base tip in one new commit naming them, so a plain push updates the PR; it never rewrites history, and a force push is never needed or allowed.

### Submit when your own criteria pass

The full suite is CI's gate, not the worker's (GY-853). A worker runs the build and `graphyard verify GY-N` (its own criteria's proofs only) and submits when they pass, naming in the PR any sandbox-only full-suite failure outside `plannedFiles`, with no blocker. `verify` marks a proof `leftToCi` only when all its own cases executed and passed but the run ended abnormally (a hook, crash or signal from other suites); it then exits 0 and `complete` reports `passing`. A failed, skipped or unexecuted case blocks. `verify` also runs each passing proof against the merge base with `origin/BASE` with the change's test-side files (`*.test.*`; any `tests/`, `test/`, `__tests__/`, `fixtures/`) (GY-1174): a proof still passing there checks nothing the change adds, so it is `unexercised`, `verify` exits 1 and `complete` reports `failing`. A tests-only change is not judged. A base run not made is `indeterminate`, with its reason; `--preserves PROOF` exempts a regression guard (GY-1240).

### Generated files never conflict

`docs/README.md` and `docs/protocol.md` are generated in full ([development](development.md)) and `init` renders the managed `AGENTS.md` blocks; `sync` regenerates them after merging. The regression guard classifies `GRAPHYARD_GENERATED_FILES` paths (here `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md`) as `generated`, refusing only a deletion.

## Ship in under thirty minutes

The [routine target](master-agent-reference.md#pipeline-speed) comes from `sync`, automatic dispatch, [proofs in CI](github.md#proofs-in-ci), conflict avoidance; never weaker gates.

## Explain stalls

`graphyard diagnose GY-N` explains the refusing gate and what else holds it; `base-behind`/`base-conflict` get rework or, docs-only, [docs-sync](development.md#documentation-that-rarely-conflicts). Its launcher creates `.graphyard/docs-sync/<KEY>-<head7>`; confinement leaves only it and the shared Git directory writable; an unwritable one is refused, named, for rework. Three unobserved observation jobs in a row are `observation-starved`: master attention and `/api/status` `starvedJobs`.
