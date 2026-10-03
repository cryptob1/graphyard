<!-- page: Operate Graphyard | 10 | criteria, overlap and scope. -->
# Coordination

## Write observable criteria

Criterion: `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. `unit:`/`integration:` are producer-runnable on the exact head ([automatic dispatch](master-agent.md#automatic-dispatch-at-submit)); `manual:` needs two-party attestation unless in `producerProofs`; judged, not title-counted, a trusted pass proves it whatever it executed (`unit:`/`integration:`/`e2e:` need `executed > 0`); `e2e:` uses the [validation runner](validation.md).

`graphyard master requirements GY-N revision.json "REASON"` adds; rewriting, removing, narrowing: two-party `master decide GY-N requirements @revision.json "REASON"`. Revisions replace the document (`expectedPolicyRevision`), lapsing evidence, review, authorization.

## Dispatch optimistically, smallest scope first

`plannedFiles` (paths, `/`-ending prefixes) is the scope contract, not a lock: the [merge queue](github.md#merge-queue), `sync` integrate overlaps. `master status` shows `overlap.concurrent`, `git merge-tree` failures. Root-level directories are `highConflict`, refused without `--allow-broad-scope`; only `exclusiveResources` (reserved at claim) hold dispatch.

## Review gate: verdicts, not threads

Gate: reviewer approval of the exact head plus required CI; threads are inputs. Approvals mark each listed thread resolved, follow-up (held until ship, then filed) or overridden by thread or comment ID; missed threads withdraw approval, relaunching to resolve by thread ID. After two rework rounds bot threads are advisory. Required conversation resolution is drift: `master protection --apply`.

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` bounds changes: at `complete`, each new head and landing, files inside scope, new files and touched `tests/helpers/timing-baseline.json` lines pass; every other file must match base byte-for-byte. Carried files (unlanded commits) never eject; only scope requests or audited revisions widen it.

`evaluateLandability` (`src/model/landability.ts`) is the single authority on landing: build/acceptance gates and queue ejections are its refusals. Published as required check `graphyard/landable` (`success`, or `failure` with reasons), never a verdict input.

Out-of-scope files are three-way merged onto the landing commit: extended or base-only changes pass; reverts, deletions, rewrites refuse.

Pre-push, `graphyard sync GY-N` merges `origin/BASE` (no rebase), regenerates, commits; `graphyard sync GY-N --restore` also restores out-of-scope files to the base tip in one commit (plain push, never force).

### Submit when your own criteria pass

The full suite is CI's gate (GY-853): workers run the build and `graphyard verify GY-N` (own proofs), submit on pass, and name any sandbox full-suite failure outside `plannedFiles` in the PR without a blocker. `verify` marks a proof `leftToCi`, exits 0 and `complete` reports `passing` naming it, only when all cases passed but the run ended abnormally (hook, crash, signal); failed, skipped or unexecuted cases always block.

### Generated files never conflict

`docs/README.md`, `docs/protocol.md` are generated in full ([development](development.md)); `sync` regenerates them post-merge. `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` paths are `generated`: only deletion refuses.

## Ship in under thirty minutes

[Speed](master-agent-reference.md#pipeline-speed): `sync`, automatic dispatch, [proofs in CI](github.md#proofs-in-ci), conflict avoidance, never weaker gates. `graphyard diagnose GY-N` names the refusing gate, other holds; conflicting `base-behind`/`base-conflict` get rework. Three consecutive unobserved observation jobs: `observation-starved` (master attention; `/api/status` `starvedJobs`).
