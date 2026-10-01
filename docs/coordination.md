<!-- page: Operate Graphyard | 10 | criteria, overlap and scope. -->
# Coordination

## Write observable criteria

A criterion is `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. `unit:`/`integration:` proofs are producer-runnable on the exact head ([automatic dispatch](master-agent.md#automatic-dispatch-at-submit)). A `manual:` proof is a two-party attested decision unless `producerProofs` lists it; judged, not title-counted, its trusted pass proves it whatever it executed (`unit:`/`integration:`/`e2e:` need `executed > 0`). `e2e:` uses the [validation runner](validation.md).

## Revise requirements explicitly

`graphyard master requirements GY-N revision.json "REASON"` adds; rewriting, removing or narrowing needs a two-party `master decide GY-N requirements @revision.json "REASON"`. A revision (against `expectedPolicyRevision`) lapses evidence, review and authorization; stop the worker first unless only widening plannedFiles.

## Dispatch optimistically, smallest scope first

`plannedFiles` (paths, or `/`-ending directory prefixes) is the scope contract, not a lock: the [merge queue](github.md#merge-queue) and `sync` integrate overlaps. `master status` shows `overlap.concurrent` and candidates `git merge-tree` cannot merge. A root-level directory is `highConflict`, refused without `--allow-broad-scope`. Only `exclusiveResources`, reserved at claim, hold a dispatch.

## Review gate: verdicts, not threads

The gate is reviewer approval of the exact head plus required CI; an approval marks each thread resolved, follow-up (backlog) or overridden. Ten identical 4xx failures stop retries with one attention item. Bot threads turn advisory after two rework rounds. Required conversation resolution is drift: `master protection --apply`.

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` also bounds the candidate's diff: at `complete`, each new head and landing, a pre-existing out-of-scope file must match the bound base byte-for-byte or is refused, naming files and shipping items. Carried (another item's unlanded) commits never eject. Only a scope request or audited revision widens it; asks over 20 files in a directory, or 100 entries, collapse to the deepest common directory; pending asks merge into one decision.

`evaluateLandability` (`src/model/landability.ts`) is the single authority on whether a candidate can land: build and acceptance gates are its refusals, and the queue ejects only for its reasons. Recomputed live, never stored; a newly landable head re-enters the queue.

### Keep current with `graphyard sync`

The landing check three-way merges the head onto its landing commit: out-of-scope changes that commit extended, or only the base made, pass; restoring the merge-base version, deleting or rewriting is refused. Observations recompute it; stale refusals clear without a push.

Before any push, `graphyard sync GY-N` merges `origin/BASE` (never rebases), regenerates and commits. Restore an out-of-scope file: `git checkout BASE_TIP -- PATH`.

### Generated files never conflict

`sync` regenerates `docs/README.md`, `docs/protocol.md` ([development](development.md)) and the managed `AGENTS.md` blocks. The regression guard treats paths in `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` as `generated`, refusing only a deletion.

## Ship in under thirty minutes

[Speed](master-agent-reference.md#pipeline-speed) comes from `sync`, automatic dispatch and [proofs in CI](github.md#proofs-in-ci), never weaker gates.

## Explain stalls

`graphyard diagnose GY-N` names the refusing gate and other holds; `base-behind`/`base-conflict` get rework. Three consecutive unobserved observation jobs are `observation-starved` (master attention, `/api/status` `starvedJobs`).
