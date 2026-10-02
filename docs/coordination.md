<!-- page: Operate Graphyard | 10 | criteria, overlap and scope. -->
# Coordination

## Write observable criteria

A criterion is `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. `unit:`/`integration:` proofs are producer-runnable on the exact head ([automatic dispatch](master-agent.md#automatic-dispatch-at-submit)). A `manual:` proof is a two-party attested decision unless `producerProofs` lists it; judged, not title-counted, its trusted pass proves it whatever it executed (`unit:`/`integration:`/`e2e:` need `executed > 0`). `e2e:` uses the [validation runner](validation.md).

## Revise requirements explicitly

`graphyard master requirements GY-N revision.json "REASON"` adds; rewriting, removing or narrowing needs a two-party `master decide GY-N requirements @revision.json "REASON"`. A revision (against `expectedPolicyRevision`) lapses evidence, review and authorization; stop the worker first unless only widening plannedFiles.

## Dispatch optimistically, smallest scope first

`plannedFiles` (paths, or `/`-ending directory prefixes) is the scope contract, not a lock: the [merge queue](github.md#merge-queue) and `sync` integrate overlaps. `master status` shows `overlap.concurrent` and candidates `git merge-tree` cannot merge. A root-level directory is `highConflict`, refused without `--allow-broad-scope`. Only `exclusiveResources`, reserved at claim, hold a dispatch.

## Review gate: verdicts, not threads

The gate is the reviewer's approval of the exact head plus required CI; threads are inputs: an approval names each listed one resolved, follow-up (filed as backlog) or overridden, or is withdrawn; the loop resolves those named. A filing refused as a reused idempotency key links that key's item (same parent and approval), or files under an approval-and-body-hash key. Retries stop after 10 consecutive identical 4xx failures, raising one attention item naming step, error and item. After two rework rounds a bot's thread is advisory. Required conversation resolution is drift: `master protection --apply`.

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` also bounds what a candidate may change. At `complete`, on every new head and at landing, files inside scope and new files pass; every other file must match the bound base byte-for-byte. A deletion, revert or rewrite is refused, naming the files and their shipping items; carried files (another item's unlanded commits) are no ejection (GY-871). A worker cannot widen `plannedFiles`; a scope request or audited revision can. Asks over 20 files in one directory, or past the 100-entry cap, become their deepest common directory (`tests/`), naming the files covered; pending asks merge into one decision.

`evaluateLandability` (`src/model/landability.ts`) is the single authority on whether a candidate can land: build and acceptance gates are its refusals, and the queue ejects only for its reasons. Recomputed live, never stored; a newly landable head re-enters the queue.

### Keep current with `graphyard sync`

The landing check three-way merges the head onto its landing commit: out-of-scope changes that commit extended, or only the base made, pass; restoring the merge-base version, deleting or rewriting is refused. Observations recompute it; stale refusals clear without a push.

Before any push, `graphyard sync GY-N` merges `origin/BASE` (never rebases), regenerates, commits and prints the classification. `--restore` also restores every out-of-scope file to the base tip in one new commit naming them, so a plain push updates the PR; no history rewrite or force push.

### Generated files never conflict

`sync` regenerates `docs/README.md`, `docs/protocol.md` ([development](development.md)) and the managed `AGENTS.md` blocks. The regression guard treats paths in `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` as `generated`, refusing only a deletion.

## Ship in under thirty minutes

[Speed](master-agent-reference.md#pipeline-speed) comes from `sync`, automatic dispatch and [proofs in CI](github.md#proofs-in-ci), never weaker gates.

## Explain stalls

`graphyard diagnose GY-N` names the refusing gate and other holds; `base-behind`/`base-conflict` get rework. Three consecutive unobserved observation jobs are `observation-starved` (master attention, `/api/status` `starvedJobs`).
