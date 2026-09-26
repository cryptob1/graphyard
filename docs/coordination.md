<!-- page: Operate Graphyard | 10 | criteria, overlap and scope. -->
# Coordinating independent agents

## Write observable criteria

A criterion states an outcome and its proofs:

```json
{"id":"AC-1","text":"Retrying a confirmed booking produces exactly one SMS request","proofs":["integration:sms-idempotency"]}
```

`unit:` and `integration:` proofs are producer-runnable on the exact head ([automatic dispatch](master-agent.md#automatic-dispatch-at-submit)). A `manual:` proof is attested by a two-party decision unless `producerProofs` lists it. `e2e:` proofs run through the [validation runner](validation.md).

## Revise requirements explicitly

`graphyard master requirements GY-N revision.json "REASON"` adds; rewriting, removing or narrowing is a two-party `master decide GY-N requirements @revision.json "REASON"`. A revision replaces the whole document against `expectedPolicyRevision`; stop the worker first (widening excepted): prior evidence, review and authorization lapse.

## Dispatch optimistically, smallest scope first

`plannedFiles` (paths, or directory prefixes ending in `/`) is the change-scope contract, not a lock: the merge queue and `sync` rework integrate overlapping items, and [GitHub merges](github.md#merge-queue). `master status` records `overlap.concurrent` and `git merge-tree` conflicts. Smallest planned scope dispatches first; a root-level directory is `highConflict`, refused without `--allow-broad-scope`. Only `exclusiveResources`, reserved at claim, hold a dispatch.

## Review gate: verdicts, not threads

The gate is the reviewer's approval of the exact head plus required CI. Threads are its inputs: an approval names each listed one resolved, follow-up (filed as backlog) or overridden, or is withdrawn; the loop resolves those named. After two rework rounds a bot's thread is advisory. Required conversation resolution is drift: `master protection --apply`.

## Refuse candidates that revert shipped code outside their scope

At `complete`, on every new head and at landing, `plannedFiles` bounds the candidate: files inside it and new files pass; every other file must match the bound base byte-for-byte, or is refused naming the items that shipped it. Only a scope request or audited revision widens `plannedFiles`. Asks over 20 files in one directory, or past the 100-entry cap, become their deepest common directory (`tests/`), naming the files covered; pending asks merge into one decision.

### Keep current with `graphyard sync`

`graphyard sync GY-N` merges `origin/BASE` (never a rebase), regenerates, commits and prints that classification before any push. Restore an out-of-scope file with `git checkout BASE_TIP -- PATH`.

### Generated files never conflict

`docs/README.md` and `docs/protocol.md` are generated in full ([development](development.md)) and `init` renders the managed `AGENTS.md` blocks; `sync` regenerates them after merging. The regression guard treats `GRAPHYARD_GENERATED_FILES` paths (here `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md`) as `generated`, refusing only deletion.

## Ship in under thirty minutes

The [routine target](master-agent-reference.md#pipeline-speed) comes from `sync`, automatic dispatch, [proofs in CI](github.md#proofs-in-ci) and conflict avoidance, never by weakening a gate.

## Explain stalls

`graphyard diagnose GY-N` explains the first refusing gate and anything else holding it; conflicting `base-behind` and `base-conflict` get rework.
