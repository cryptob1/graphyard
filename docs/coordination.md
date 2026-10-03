<!-- page: Operate Graphyard | 10 | criteria, overlap and scope. -->
# Coordination

## Write observable criteria

A criterion is `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. `unit:`/`integration:` proofs are producer-runnable on the exact head ([automatic dispatch](master-agent.md#automatic-dispatch-at-submit)). A `manual:` proof is a two-party attested decision unless `producerProofs` lists it; judged, not title-counted, its trusted pass proves it whatever it executed (`unit:`/`integration:`/`e2e:` need `executed > 0`). `e2e:` uses the [validation runner](validation.md).

## Revise requirements explicitly

`graphyard master requirements GY-N revision.json "REASON"` adds; rewriting, removing or narrowing needs a two-party `master decide GY-N requirements @revision.json "REASON"`. A revision (against `expectedPolicyRevision`) lapses evidence, review and authorization; stop the worker first unless only widening plannedFiles.

## Dispatch optimistically, smallest scope first

`plannedFiles` (paths, or `/`-ending directory prefixes) is the scope contract, not a lock: the [merge queue](github.md#merge-queue) and `sync` integrate overlaps. `master status` shows `overlap.concurrent` and candidates `git merge-tree` cannot merge. A root-level directory is `highConflict`, refused without `--allow-broad-scope`. Only `exclusiveResources`, reserved at claim, hold a dispatch.

## Review gate: verdicts, not threads

The gate is reviewer approval of the exact head plus required CI; threads are inputs: approval names each listed thread resolved, follow-up (held until ship) or overridden by ID; the loop resolves named threads by ID. Refused duplicate filings link the existing item or use an approval-and-body-hash key. Retries stop after 10 identical 4xx failures, raising one attention item. After two rework rounds bot threads are advisory. Past the review-round cap (default 3) only a `BLOCKING:` finding holds a head, escalating rather than reworking ([follow-ups](followups.md#past-the-review-round-cap)). Required conversation resolution is drift: `master protection --apply`.

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` also bounds what a candidate may change. At `complete`, on every new head and at landing, files inside scope and new files pass, as do `tests/helpers/timing-baseline.json` lines of tests touched; every other file must match the bound base byte-for-byte. Deletions, reverts or rewrites are refused; carried files never eject. Workers cannot widen `plannedFiles`; scope requests or revisions can. Asks over 20 files in one directory become their deepest common directory (`tests/`); pending asks merge into one decision.

`evaluateLandability` (`src/model/landability.ts`) is the single authority on whether a candidate can land: build and acceptance gates are its refusals; the merge queue ejects an entry only for a reason it gives. Recomputed live; a newly landable head re-enters the queue. The control plane publishes the verdict as `graphyard/landable` on candidate heads (GY-887).

### Keep current with `graphyard sync`

The landing check three-way merges the head onto its landing commit: out-of-scope changes that commit extended pass; deleting or rewriting is refused. Observations recompute it, clearing stale refusals.

Before pushing, `graphyard sync GY-N` merges `origin/BASE` (never rebases), regenerates and commits. `graphyard sync GY-N --restore` restores every out-of-scope file to the base tip in a commit naming them; it never rewrites history or force-pushes.

### Submit when your own criteria pass

The full suite is CI's gate, not the worker's: a worker builds, runs `graphyard verify GY-N` (its criteria proofs only) and submits when they pass, naming in the PR any sandbox-only full-suite failure outside `plannedFiles`. A proof whose own cases all passed in a run ending abnormally is `leftToCi`: `verify` exits 0 and `complete` reports `passing`. A failed, skipped or unexecuted case always blocks.

### Generated files never conflict

`sync` regenerates `docs/README.md`, `docs/protocol.md` ([development](development.md)) and the managed `AGENTS.md` blocks. The regression guard treats paths in `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` as `generated`, refusing only a deletion.

## Ship in under thirty minutes

[Speed](master-agent-reference.md#pipeline-speed): `sync`, automatic dispatch, [proofs in CI](github.md#proofs-in-ci), never weaker gates.

## Explain stalls

`graphyard diagnose GY-N` names the refusing gate and other holds; `base-behind`/`base-conflict` get rework. Three consecutive unobserved observation jobs are `observation-starved` (master attention, `/api/status` `starvedJobs`).
