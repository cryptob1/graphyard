<!-- page: Operate Graphyard | 10 | criteria, overlap and scope. -->
# Coordination

## Write observable criteria

Criterion: `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. `unit:`/`integration:` are producer-runnable on the exact head ([automatic dispatch](master-agent.md#automatic-dispatch-at-submit)); `manual:` needs two-party attestation unless in `producerProofs`; judged, not title-counted, a trusted pass proves it whatever it executed (`unit:`/`integration:`/`e2e:` need `executed > 0`); `e2e:` uses the [validation runner](validation.md).

`graphyard master requirements GY-N revision.json "REASON"` adds; rewriting, removing, narrowing: two-party `master decide GY-N requirements @revision.json "REASON"`. Revisions replace the document (`expectedPolicyRevision`), lapsing evidence, review, authorization.

## Dispatch optimistically, smallest scope first

`plannedFiles` (paths, `/`-ending prefixes) is the scope contract, not a lock: the [merge queue](github.md#merge-queue), `sync` integrate overlaps. `master status` shows `overlap.concurrent`, `git merge-tree` failures. Root-level directories are `highConflict`, refused without `--allow-broad-scope`; only `exclusiveResources` (reserved at claim) hold dispatch.

`worktree GY-N EPOCH` frees the branch first: an earlier attempt's worktree is recorded (`workspace.preserved`) and detached, abandoned ones removed (`reclaimed`). A workspace failure releases the claim without spending the epoch. After **3** single-cause dispatch failures, the loop records a `dispatchblock` blocker until `graphyard unblock GY-N REASON`.

## Review gate: verdicts, not threads

Reviewer approval of the exact head plus required CI gates landing; threads are inputs. Approvals mark each listed thread resolved, follow-up (filed on ship) or overridden; a missed thread withdraws the approval. After two rework rounds bot threads are advisory. Past the review-round cap (default 3) only a `BLOCKING:` finding holds a head, escalating rather than reworking ([follow-ups](followups.md#past-the-review-round-cap)). Required conversation resolution is drift: `master protection --apply`.

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` bounds changes at `complete`, new heads and landings: files in scope, new files and touched `tests/helpers/timing-baseline.json` lines pass; others must match base byte-for-byte. Scope requests or audited revisions widen it.

`evaluateLandability` (`src/model/landability.ts`) is the single authority on landing: build/acceptance gates and queue ejections are its refusals, published as required check `graphyard/landable`, never a verdict input.

Out-of-scope files three-way merge onto the landing commit: extended or base-only changes pass; reverts, deletions, rewrites refuse.

Pre-push, `graphyard sync GY-N` merges `origin/BASE` (no rebase), regenerates, commits; `graphyard sync GY-N --restore` restores out-of-scope files to base tip in one commit (plain push, never force).

### Submit when your own criteria pass

The full suite is CI's gate: workers run build and `graphyard verify GY-N` (own proofs), submit on pass, and name any sandbox full-suite failure outside `plannedFiles` in the PR without a blocker. `verify` marks a proof `leftToCi`, exits 0 and `complete` reports `passing` naming it, only when all cases passed but the run ended abnormally (hook, crash, signal); failed, skipped or unexecuted cases always block. A proof that still passes on the merge base carrying only the change's test files (`tests/`, `*.test.*`) is `unexercised`: `verify` exits 1 and `complete` reports `failing` (tests-only changes are not judged).

### Generated files never conflict

`docs/README.md`, `docs/protocol.md` are generated in full ([development](development.md)); `sync` regenerates them post-merge. `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` paths are `generated`: only deletion refuses.

## Ship in under thirty minutes

[Speed](master-agent-reference.md#pipeline-speed): `sync`, automatic dispatch, [proofs in CI](github.md#proofs-in-ci), conflict avoidance, never weaker gates. `graphyard diagnose GY-N` names refusing gate, other holds; `base-behind`/`base-conflict` get rework or, docs-only, [docs-sync](development.md#documentation-that-rarely-conflicts). Three unobserved observation jobs: `observation-starved` (master attention; `/api/status` `starvedJobs`).
