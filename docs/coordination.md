<!-- page: Operate Graphyard | 10 | criteria, overlap and scope. -->
# Coordination

## Write observable criteria

Criterion: `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. `unit:`/`integration:` are producer-runnable on the exact head ([automatic dispatch](master-agent.md#automatic-dispatch-at-submit)); `manual:` needs two-party attestation unless in `producerProofs`; judged, not title-counted, a trusted pass proves it whatever it executed (`unit:`/`integration:`/`e2e:` need `executed > 0`); `e2e:` uses the [validation runner](validation.md).

`graphyard master create` plans criteria up front; `master requirements GY-N revision.json "REASON"` adds; rewriting, removing, narrowing: two-party `master decide GY-N requirements @revision.json "REASON"`. Revisions replace the document (`expectedPolicyRevision`) and lapse evidence, review, authorization.

## Dispatch optimistically, smallest scope first

`plannedFiles` (paths, `/`-ending prefixes) is the scope contract, not a lock: `sync` and GitHub's merges into main ([one delivery path](delivery.md#one-delivery-path)) integrate overlaps. `master status` shows `overlap.concurrent`, `git merge-tree` failures. Root-level directories are `highConflict`, refused without `--allow-broad-scope`; only `exclusiveResources` (reserved at claim) hold dispatch.

`worktree GY-N EPOCH` frees the branch first: an earlier attempt's worktree is recorded (`workspace.preserved`) and detached, abandoned ones removed (`reclaimed`). A workspace failure releases the claim without spending the epoch. After **3** single-cause dispatch failures, the loop records a `dispatchblock` blocker until `graphyard unblock GY-N REASON`.

## Review gate: verdicts, not threads

Reviewer approval of the exact head plus required CI gates landing; threads are inputs. Approvals mark each listed thread resolved, follow-up (a nit, answered and resolved, never filed; anything worth fixing is `BLOCKING` and fixed on that PR) or overridden, by thread or comment ID; a missed thread withdraws the approval. After two rework rounds bot threads are advisory. Past the review-round cap (default 3) only a `BLOCKING:` finding holds a head, escalating rather than reworking; a capped request without one is withdrawn and re-reviewed. Required conversation resolution is drift: `master protection --apply`.

Each nit is a `Nit: PATH:LINE — FINDING` line ending with its class: `(mechanical: typo|docs-placement|formatting|naming)` or `(substantive: behavior|criteria|scope)`; any sign of behaviour, a criterion or scope, or no placeable path, makes it substantive. An approval raising mechanical findings holds its follow-up handling, and the review gate refuses it (so GitHub does not merge the head) unless the head is itself the bot commit, while the loop requests a bot `rework`: one worker commit on the approved head, or the Graphyard tip or refresh carrying its approval, touching only those findings' files. The fresh read sees the bot commit, the full diff and the substantive findings; `Rejected bot commit: SHA — reason` with REQUEST_CHANGES records a `misclassified-finding` [intervention](dashboard.md). A head resubmitted unchanged, or no round within 60 minutes, falls back to ordinary nits (`src/mechanical-findings.ts`).

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` bounds changes at `complete`, new heads and landings: files in scope, new files and touched `tests/helpers/timing-baseline.json` lines pass; others must match base byte-for-byte. Scope requests or audited revisions widen it.

`evaluateLandability` (`src/model/landability.ts`) is the single authority on landing: gate failures are its non-sticky refusals, published as required check `graphyard/landable`, never a verdict input.

Out-of-scope files three-way merge onto the landing commit: extended or base-only changes pass; reverts, deletions, rewrites refuse.

Pre-push, `graphyard sync GY-N` merges `origin/BASE` (no rebase), regenerates, commits; `graphyard sync GY-N --restore` restores out-of-scope files to base tip in one commit.

### Submit when your own criteria pass

The full suite is CI's gate: workers run build and `graphyard verify GY-N` (own proofs), submit on pass, and name any sandbox full-suite failure outside `plannedFiles` in the PR without a blocker. `verify` marks a proof `leftToCi`, exits 0 and `complete` reports `passing`, only when all cases passed but the run ended abnormally (hook, crash, signal); failed, skipped or unexecuted cases always block. A proof that still passes on the merge base carrying only the change's test-side files (`*.test.*`, `tests/`, `test/`, `__tests__/`, `fixtures/`) is `unexercised`: `verify` exits 1 and `complete` reports `failing` (tests-only changes are not judged). A base run not made is `indeterminate`; `--preserves PROOF` exempts a regression guard.

### Generated files never conflict

`docs/README.md`, `docs/protocol.md` are generated in full ([development](development.md)); `sync` regenerates them post-merge. `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` paths are `generated`: only deletion refuses.

## Ship in under thirty minutes

[Speed](master-agent-reference.md#pipeline-speed): `sync`, automatic dispatch, [proofs in CI](github.md#proofs-in-ci), conflict avoidance. `graphyard diagnose GY-N` names holds; `base-behind`/`base-conflict` get rework or, docs-only, [docs-sync](development.md#documentation-that-rarely-conflicts), launched in its own managed checkout. Three unobserved observation jobs: `observation-starved` (master attention; `/api/status` `starvedJobs`).

A stalled row's attention and escalation name its reason's bound remedy (`src/stall-remedies.ts`); an unrecognised reason keeps the generic line. On an App permission hold the loop runs `master browser installation-accept` (`app-permissions` first when needed) once per unchanged run and records the outcome on the row (`POST /api/actions/:id/remedy`); a refusal escalates once and is never retried. A full role names its capacity lever: `master registry role set ROLE ACCOUNT… --concurrency N`, or a live session ending.
