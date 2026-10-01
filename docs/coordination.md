<!-- page: Operate Graphyard | 10 | criteria, overlap, scope. -->
# Coordination

## Write observable criteria

Criteria name outcomes and proofs (`"proofs":["integration:sms-idempotency"]`): `unit:`/`integration:` are producer-runnable on the exact head ([automatic dispatch](master-agent.md#automatic-dispatch-at-submit)), `e2e:` use the [validation runner](validation.md). A `manual:` proof needs two-party attestation unless `producerProofs` lists it; judged, not title-counted, its trusted pass proves it whatever it executed (`unit:`/`integration:`/`e2e:` need `executed > 0`).

## Revise requirements explicitly

`graphyard master requirements GY-N revision.json "REASON"` adds; rewrite, removal or narrowing needs two-party `master decide GY-N requirements @revision.json "REASON"`. A revision replaces the document against `expectedPolicyRevision`, lapsing evidence, review and authorization; stop the worker first unless only widening plannedFiles.

## Dispatch optimistically, smallest scope first

`plannedFiles` (paths or `/`-ending directory prefixes) is a scope contract, not a lock: the [merge queue](github.md#merge-queue) and `sync` integrate overlaps, and only `exclusiveResources`, reserved at claim, hold dispatch. `master status` records `overlap.concurrent` and candidates `git merge-tree` cannot merge. Root-level directories are `highConflict`, refused without `--allow-broad-scope`.

## Review gate: verdicts, not threads

The gate is exact-head reviewer approval plus required CI. Approvals mark each listed thread resolved, follow-up (backlog) or overridden, or are withdrawn; the loop resolves threads. A filing refused for a reused idempotency key links that key's item (same parent, approval), else uses an approval-and-body-hash key; 10 consecutive identical 4xx failures stop retries with one attention item (step, error, item). Bot threads turn advisory after two rework rounds. Required conversation resolution is drift: `master protection --apply`.

## Refuse candidates that revert shipped code outside their scope

At `complete`, each new head and landing, a file neither new nor in `plannedFiles` must match the bound base byte-for-byte or is refused (deletion, revert, rewrite), naming files and shipping items; carried files (another item's unlanded commits) don't eject. Only a scope request or audited revision, never the worker, widens `plannedFiles`; asks over 20 files in one directory or past the 100-entry cap collapse to their deepest common directory (`tests/`) listing covered files, and pending asks merge into one decision.

`evaluateLandability` (`src/model/landability.ts`) is the single authority on landing: gates (build, acceptance) and queue ejections carry its refusals with its version and inputs. It is recomputed from live facts (candidate SHA, policy revision), never stored, so refusals aren't sticky: a landable head re-enters.

### Keep current with `graphyard sync`

Each out-of-scope file is judged by the head's three-way merge onto the landing commit (live or predicted base): a change that commit extended, or only the base made, passes; restoring the merge-base version, deleting or rewriting is refused. Observations recompute it, clearing stale refusals without a push; false refusals arise only where a compare lacks a merge base.

Before pushing, `graphyard sync GY-N` merges `origin/BASE` (never rebases), regenerates, commits and prints the classification; restore a file with `git checkout BASE_TIP -- PATH`.

### Generated files never conflict

`GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` lists files [generated in full](development.md), classed `generated`: only deletion is refused. `sync` regenerates them; `init` renders managed `AGENTS.md` blocks.

## Ship in under thirty minutes

The [routine target](master-agent-reference.md#pipeline-speed) needs `sync`, automatic dispatch, [proofs in CI](github.md#proofs-in-ci) and conflict avoidance, never weaker gates.

## Explain stalls

`graphyard diagnose GY-N` names the refusing gate and other holds; conflicting `base-behind`/`base-conflict` get rework. Three straight unobserved observation jobs raise `observation-starved` (master attention, `/api/status` `starvedJobs`).
