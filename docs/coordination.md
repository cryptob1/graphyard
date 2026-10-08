<!-- page: Operate Graphyard | 10 | criteria, scope. -->
# Coordination

## Write observable criteria

Criterion: `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. `unit:`/`integration:`: producer-runnable on exact head ([dispatch](master-agent.md#automatic-dispatch-at-submit)); `manual:`: two-party attestation unless in `producerProofs`, judged, not title-counted; `e2e:`: [runner](validation.md). Any trusted pass proves it whatever it executed (`unit:`/`integration:`/`e2e:` need `executed > 0`). `graphyard master create` plans; `master requirements GY-N revision.json "REASON"` adds; rewrite/removal/narrowing: two-party `master decide GY-N requirements @revision.json "REASON"`. Revisions replace the document (`expectedPolicyRevision`), lapsing evidence, review, authorization.

## Dispatch optimistically, smallest scope first

`plannedFiles` (paths, `/`-ending prefixes) scope, never lock: `sync` and GitHub's [merges](delivery.md#one-delivery-path) integrate overlaps (`master status`: `overlap.concurrent`, `git merge-tree` failures). Root-level directories (`highConflict`) need `--allow-broad-scope`; only `exclusiveResources` (claim-reserved) hold dispatch.

`worktree GY-N EPOCH` detaches earlier attempts' worktrees (`workspace.preserved`), removes abandoned ones (`reclaimed`); on failure releases claim unspent. Launch renews lease from claim. Unacknowledged reviewer/producer launches fail after start bound + 120s. Lease-less idle/done Herdr sessions are launchable (pane closed); refusals name each agent's state, remedy. **3** single-cause failures, fleet-idle excluded: `dispatchblock` blocker until `graphyard unblock GY-N REASON`; older fleet-idle ones (`dispatch-failure`) clear once launchable.

## Review gate: verdicts, not threads

Exact-head approval plus required CI land; threads are inputs, each (thread/comment ID) marked resolved, follow-up (answered nit, never filed; fixes are `BLOCKING`, on that PR) or overridden, else approval withdraws. After two rework rounds bot threads are advisory; past round cap (default 3) only `BLOCKING:` holds, escalating, its rework to independent approver (not risk lane); capped requests without one: withdrawn, re-reviewed. Required conversation resolution: drift, `master protection --apply`. Control-plane anchors on `risk`: `review-launch` registers the reviewer; `review post` hits `review-verdict` as its one-time token (never `gh`); sensitive needs exact-head approval; normal merges then one post-merge review whose `BLOCKING:` lines each file a priority-1 bug (none dropped, filed across ticks).

`Nit: PATH:LINE — FINDING` ends `(mechanical: typo|docs-placement|formatting|naming)` or `(substantive: behavior|criteria|scope)`; behaviour/criterion/scope signs or no path mean substantive. Mechanical findings: gate refuses (unless head is bot commit); loop requests bot `rework`, one commit (or approval-carrying refresh) on approved head touching only those files. `Rejected bot commit: SHA — reason` with REQUEST_CHANGES records `misclassified-finding` ([intervention](dashboard.md)). Unchanged resubmission or 60 idle minutes: plain nits (`src/mechanical-findings.ts`).

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` bounds `complete`, new heads, landings (`AGENTS.md`): new files, `tests/helpers/timing-baseline.json` lines for changed or unrecorded tests pass; out-of-scope files three-way merge onto landing commit (extending or base-only pass; reverts, deletions, rewrites refuse). `evaluateLandability` (`src/model/landability.ts`), single authority on landing: non-sticky refusals in required check `graphyard/landable`, never verdict inputs; acceptance (proof) family unpublished, gating nothing. Pre-push `graphyard sync GY-N` merges `origin/BASE` (no rebase); `--restore` resets out-of-scope files to base tip, one commit. A Claude worker's harness runs `graphyard scope-guard GY-N EPOCH` as a `PreToolUse` hook on edits: one `complete` would refuse against the live `plannedFiles` exits 2 naming `scope-request GY-N EPOCH PATH --wait -- REASON`. Other runtimes get no hook; `complete` is authoritative.

CI runs full suite; workers run build, `graphyard verify GY-N` (own proofs), submit on pass, naming out-of-scope sandbox failures in PR. `leftToCi` (exit 0, `passing`): all passed, abnormal end; failed/skipped/unexecuted block. Passing on merge base with only test-side files (`*.test.*`, `tests/`, `test/`, `__tests__/`, `fixtures/`): `unexercised`, exit 1, `failing`; tests-only changes unjudged; no base run: `indeterminate`. `--preserves PROOF` exempts regression guards.

### Generated files never conflict

`GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` paths are `generated`: only deletion refuses; `sync` regenerates.

## Ship in under thirty minutes

[Speed](master-agent-reference.md#pipeline-speed), [proofs in CI](github.md#proofs-in-ci). `graphyard diagnose GY-N` names holds; `base-behind`/`base-conflict`: rework or, docs-only, [docs-sync](development.md#documentation-that-rarely-conflicts) (own checkout). Polls save only on moved submission, candidate, policy or queue tip; three unsaved escalate once (`observation.no-save-escalated`, `observation-starved` attention, `/api/status` `starvedJobs`).

Stalled rows name remedies (`src/stall-remedies.ts`, else generic): App permission holds run `master browser installation-accept` (`app-permissions` first if needed) once per unchanged run (`POST /api/actions/:id/remedy`); refusals escalate once; full roles: `master registry role set ROLE ACCOUNT… --concurrency N` or session ending.
