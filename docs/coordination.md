<!-- page: Operate Graphyard | 10 | criteria, overlap and scope. -->
# Coordination

## Write observable criteria

Criterion: `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. `unit:`/`integration:` are producer-runnable on the exact head ([automatic dispatch](master-agent.md#automatic-dispatch-at-submit)); `manual:` needs two-party attestation unless in `producerProofs`; judged, not title-counted, a trusted pass proves it whatever it executed (`unit:`/`integration:`/`e2e:` need `executed > 0`); `e2e:` uses the [validation runner](validation.md).

`graphyard master requirements GY-N revision.json "REASON"` adds; rewriting, removing, narrowing: two-party `master decide GY-N requirements @revision.json "REASON"`. Revisions replace the document (`expectedPolicyRevision`), lapsing evidence, review, authorization; stop the worker first unless only widening plannedFiles.

## Dispatch optimistically, smallest scope first

`plannedFiles` (paths, `/`-ending prefixes) is the scope contract, not a lock: the [merge queue](github.md#merge-queue), `sync` integrate overlaps. `master status` shows `overlap.concurrent`, `git merge-tree` failures. Root-level directories are `highConflict`, refused without `--allow-broad-scope`; only `exclusiveResources` (reserved at claim) hold dispatch.

## Review gate: verdicts, not threads

Gate: reviewer approval of the exact head plus required CI; threads are inputs. Approvals mark each listed thread resolved, follow-up (backlog) or overridden by thread ID or a comment ID the prompt shows (prose counts for nothing), else are withdrawn and the relaunch names missed threads; the loop resolves them by thread ID. A filing refused for a reused idempotency key links that key's item (same parent, approval) or uses an approval-and-body-hash key. 10 consecutive identical 4xx failures stop retries with one attention item (step, error, item); after two rework rounds bot threads are advisory. Required conversation resolution is drift: `master protection --apply`.

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` also bounds changes: at `complete`, each new head and landing, other non-new files must match the bound base byte-for-byte, else refused naming files, shipping items. Carried files (another item's unlanded commits) never eject; only scope requests or audited revisions widen `plannedFiles`. Asks over 20 files in one directory or the 100-entry cap collapse to the deepest common directory (`tests/`), naming files covered; pending asks merge into one decision.

`evaluateLandability` (`src/model/landability.ts`) is the single authority on landing: build/acceptance gates are its refusals; the queue ejects only for its reasons. Computed live per candidate SHA and policy revision, never stored; refusals record version, inputs; newly landable heads re-enter.

Out-of-scope files are judged by three-way merging the head onto the landing commit (live or predicted base): changes it extended or only the base made pass; restoring merge-base versions, deleting, rewriting refuse. Observations recompute, clearing stale refusals.

Pre-push, `graphyard sync GY-N` merges `origin/BASE` (no rebase), regenerates, commits, prints the classification; `graphyard sync GY-N --restore` also restores out-of-scope files to the base tip in one commit naming them (plain push, never force).

### Generated files never conflict

`docs/README.md`, `docs/protocol.md` are generated in full ([development](development.md)), managed `AGENTS.md` blocks rendered by `init`; `sync` regenerates them post-merge. `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` paths are `generated`: only deletion refuses.

## Ship in under thirty minutes

[Speed](master-agent-reference.md#pipeline-speed): `sync`, automatic dispatch, [proofs in CI](github.md#proofs-in-ci), conflict avoidance, never weaker gates. `graphyard diagnose GY-N` names the refusing gate, other holds; conflicting `base-behind`/`base-conflict` get rework. Three consecutive unobserved observation jobs: `observation-starved` (master attention; `/api/status` `starvedJobs`).
