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

`plannedFiles` (paths, or directory prefixes ending `/`) is the change-scope contract, not a lock: the [merge queue](github.md#merge-queue) and `sync` rework integrate overlapping items. `master status` records `overlap.concurrent` and candidates `git merge-tree` cannot merge. A root-level directory is `highConflict`, refused without `--allow-broad-scope`. Only `exclusiveResources`, reserved at claim, hold a dispatch. Within a priority, an item that has waited an hour (`dispatchStarvationMs`) in its stage is offered before every item that has not, whatever its scope or heat, so a broad item is never starved; among waiting items the usual order still decides.

## Review gate: verdicts, not threads

The gate is the reviewer's approval of the exact head plus required CI; threads are inputs: an approval names each listed one resolved, follow-up (filed as backlog) or overridden, or is withdrawn; the loop resolves those named. A filing refused as a reused idempotency key links that key's item (same parent and approval), or files under an approval-and-body-hash key. Retries stop after 10 consecutive identical 4xx failures, raising one attention item naming step, error and item. After two rework rounds a bot's thread is advisory. Required conversation resolution is drift: `master protection --apply`.

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` also bounds what a candidate may change. At `complete`, on every new head and at landing, files inside scope and new files pass; every other file must match the bound base byte-for-byte. A deletion, revert or rewrite is refused, naming the files and their shipping items; carried files (another item's unlanded commits) are no ejection (GY-871). A worker cannot widen `plannedFiles`; a scope request or audited revision can. Asks over 20 files in one directory, or past the 100-entry cap, become their deepest common directory (`tests/`), naming the files covered; pending asks merge into one decision.

One landability verdict, `evaluateLandability` (`src/model/landability.ts`), is the single authority on whether a candidate can land: the build and acceptance gates are its refusals, and the merge queue ejects an entry only for a reason it gives. It is computed from live facts keyed by candidate SHA and policy revision, never stored; each refusal records its version and inputs on the gate and the ejection. A landability ejection is not sticky: once the verdict is landable, the same head re-enters the queue.

### Keep current with `graphyard sync`

The landing check compares the candidate's changes since its merge base with the commit it would land on (live or predicted base). Each out-of-scope file is judged by the head's three-way merge onto it, not its blob: a change the commit has since extended, or one only the base made, merges to the commit's version, while a head restoring the merge-base version over it is still refused. Out-of-scope deletions and rewrites remain refused. Every observation recomputes this check, so stale refusals clear without a push. The simulated-day soak (`tests/soak.test.ts`) runs this check across landing-base moves, and stages a window where GitHub answers compares without a usable merge base; its false refusals hold only there.

Before any push, `graphyard sync GY-N` merges `origin/BASE` (never a rebase), regenerates, commits and prints the same classification. Restore an out-of-scope file with `git checkout BASE_TIP -- PATH`.

### Generated files never conflict

`docs/README.md` and `docs/protocol.md` are generated in full ([development](development.md)) and `init` renders the managed `AGENTS.md` blocks; `sync` regenerates them after merging. The regression guard classifies `GRAPHYARD_GENERATED_FILES` paths (here `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md`) as `generated`, refusing only a deletion.

## Ship in under thirty minutes

The [routine target](master-agent-reference.md#pipeline-speed) comes from `sync`, automatic dispatch, [proofs in CI](github.md#proofs-in-ci) and conflict avoidance, never weaker gates.

## Explain stalls

`graphyard diagnose GY-N` explains the refusing gate and what else holds it; conflicting `base-behind`/`base-conflict` get rework. Three unobserved observation jobs in a row are `observation-starved`, raised as master attention and `/api/status` `starvedJobs`.
