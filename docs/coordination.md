<!-- page: Operate Graphyard | 10 | criteria, scope. -->
# Coordination

## Write observable criteria

Criterion: `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. `unit:`/`integration:` are producer-runnable on the exact head ([automatic dispatch](master-agent.md#automatic-dispatch-at-submit)); `manual:` needs two-party attestation unless in `producerProofs`; judged, not title-counted, a trusted pass proves it whatever it executed (`unit:`/`integration:`/`e2e:` need `executed > 0`). `graphyard master create` plans criteria; `master requirements GY-N revision.json "REASON"` adds; rewriting, removing or narrowing is a two-party `master decide GY-N requirements @revision.json "REASON"`, and a revision lapses evidence, review and authorization.

## Dispatch optimistically, smallest scope first

`plannedFiles` (paths, `/`-ending prefixes) is the scope contract, not a lock: `sync` and GitHub's merges into main ([one delivery path](delivery.md#one-delivery-path)) integrate overlaps; `master status` shows `overlap` and `git merge-tree` failures. Root-level directories are `highConflict`, refused without `--allow-broad-scope`; only `exclusiveResources` hold dispatch. `worktree GY-N EPOCH` frees the branch first; a workspace failure releases the claim without spending the epoch. After **3** single-cause dispatch failures the loop records a `dispatchblock` blocker until `graphyard unblock GY-N REASON`; a fleet-idle one clears once a profile can launch.

## Review gate: verdicts, not threads

Reviewer approval of the exact head plus required CI gates landing; threads are inputs. Approvals mark each listed thread resolved, follow-up (a nit, never filed; anything worth fixing is `BLOCKING` and fixed on that PR) or overridden; a missed thread withdraws the approval. Past the review-round cap (default 3) only a `BLOCKING:` finding holds a head. Each nit is a `Nit: PATH:LINE — FINDING` line classed `(mechanical: typo|docs-placement|formatting|naming)` or `(substantive: behavior|criteria|scope)`; an approval raising mechanical findings is held while the loop requests a bot `rework` touching only those files (`src/mechanical-findings.ts`).

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` bounds changes at `complete`, new heads and landings: files in scope, new files and `tests/helpers/timing-baseline.json` lines pass; others must match base byte-for-byte or three-way merge onto the landing commit (reverts, deletions, rewrites refuse). `evaluateLandability` (`src/model/landability.ts`) is the single authority on landing, published as required check `graphyard/landable`. Pre-push, `graphyard sync GY-N` merges `origin/BASE` (no rebase), regenerates and commits; `--restore` restores out-of-scope files to the base tip.

Workers run the build and `graphyard verify GY-N` (own proofs), submit on pass and name any sandbox full-suite failure outside `plannedFiles` in the PR. `verify` marks a proof `leftToCi` only when every case passed but the run ended abnormally, and `unexercised` when it still passes on the merge base (`--preserves PROOF` exempts a regression guard).

### Generated files never conflict

`docs/README.md`, `docs/protocol.md` are generated in full ([development](development.md)); `sync` regenerates them post-merge. `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` paths are `generated`: only deletion refuses.

## Ship in under thirty minutes

[Speed](master-agent-reference.md#pipeline-speed): `sync`, automatic dispatch, [proofs in CI](github.md#proofs-in-ci), conflict avoidance. `graphyard diagnose GY-N` names holds; `base-behind`/`base-conflict` get rework or, docs-only, [docs-sync](development.md#documentation-that-rarely-conflicts). A stalled row's attention names its bound remedy (`src/stall-remedies.ts`): on an App permission hold the loop runs `master browser installation-accept` (`POST /api/actions/:id/remedy`); a full role names `master registry role set ROLE ACCOUNT… --concurrency N`.
