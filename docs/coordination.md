<!-- page: Operate Graphyard | 10 | criteria, overlap and scope. -->
# Coordinating independent agents

## Write observable criteria

A criterion states an outcome and its proofs:

```json
{"id":"AC-1","text":"Retrying a confirmed booking produces exactly one SMS request","proofs":["integration:sms-idempotency"]}
```

`unit:` and `integration:` proofs are producer-runnable: a producer runs them on the exact head ([automatic dispatch](master-agent.md#automatic-dispatch-at-submit)). A `manual:` proof is attested through a two-party decision unless listed in `producerProofs`, which makes it producer-runnable. `e2e:` proofs run through the [validation runner](validation.md).

## Revise requirements explicitly

`graphyard master requirements GY-N revision.json "REASON"` adds; rewriting, removing or narrowing is a two-party `master decide GY-N requirements @revision.json "REASON"`. A revision replaces the whole document against `expectedPolicyRevision`; stop the worker first, since prior evidence, review and authorization lapse.

## Schedule by overlap, smallest scope first

`plannedFiles` holds paths or directory prefixes ending in `/`. Overlap holds *dispatch* behind in-flight items of equal or higher priority, comparing `plannedFiles` until a candidate exists, then its changed files; no hold stands once either pull request is open. The hold lapses into attention after 30 minutes; `master dispatch GY-N PROFILE --allow-overlap` overrides it. Ready items dispatch smallest planned scope first. Name files, not directories: a root-level directory is flagged `highConflict` and refused without `--allow-broad-scope`. `master status` lists open candidates `git merge-tree` cannot merge together.

`exclusiveResources` are reserved atomically at claim.

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` also bounds what a candidate may change. At `complete`, on every new head and at landing, files inside scope and new files pass; every other file must match the bound base byte-for-byte. A deletion, revert or rewrite is refused, naming the files and the items that shipped them. A worker cannot widen `plannedFiles`; a scope request or an audited revision can.

### Keep current with `graphyard sync`

`graphyard sync GY-N` merges `origin/BASE` (never a rebase), regenerates, commits and prints the same classification before any push. Restore an out-of-scope file with `git checkout BASE_TIP -- PATH`.

### Generated files never conflict

`docs/README.md` and `docs/protocol.md` are generated in full ([development](development.md)), and the managed `AGENTS.md` blocks are rendered by `init`; `sync` regenerates them after merging. The regression guard classifies paths in `GRAPHYARD_GENERATED_FILES` (here `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md`) as `generated`, refusing only a deletion.

## Ship in under thirty minutes

The [routine target](master-agent-reference.md#pipeline-speed) comes from `sync`, automatic dispatch, [proofs in CI](github.md#proofs-in-ci) and conflict avoidance, never by weakening a gate.

## Explain stalls

`graphyard diagnose GY-N` explains the first refusing gate and anything else holding it; conflicting `base-behind` and `base-conflict` get rework.
