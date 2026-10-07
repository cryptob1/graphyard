<!-- page: Operate Graphyard | 10 | criteria, scope. -->
# Coordination

## Write observable criteria

Criterion: `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. `unit:`/`integration:`: producer-runnable on the exact head ([dispatch](master-agent.md#automatic-dispatch-at-submit)); `manual:`: two-party attestation unless in `producerProofs`, judged, not title-counted; `e2e:`: [runner](validation.md). Any trusted pass proves it whatever it executed (`unit:`/`integration:`/`e2e:` need `executed > 0`). `graphyard master create` plans; `master requirements GY-N revision.json "REASON"` adds; rewrite/removal/narrowing: two-party `master decide GY-N requirements @revision.json "REASON"`. Revisions replace document (`expectedPolicyRevision`), lapsing evidence, review, authorization.

## Dispatch optimistically, smallest scope first

`plannedFiles` (paths, `/`-ending prefixes) is scope, not lock: `sync` and GitHub's [merges](delivery.md#one-delivery-path) integrate overlaps (`master status`: `overlap.concurrent`, `git merge-tree` failures). Root-level directories (`highConflict`) need `--allow-broad-scope`; only `exclusiveResources` (claim-reserved) hold dispatch.

`worktree GY-N EPOCH` detaches earlier attempts' worktrees (`workspace.preserved`), removes abandoned ones (`reclaimed`); failing, releases the claim unspent. Launch renews the lease from the claim. Unacknowledged reviewer/producer launches fail alone after start bound + 120 s (`the claude runtime on HOST did not acknowledge the launch of …`). Snapshot fetch: 8 s, doubling per failed tick to interval; the next loop fails a killed loop's `running` doctor run. Idle/done Herdr sessions without live lease are launchable (pane closed, bounded); refusals name each agent's state, remedy. **3** single-cause failures, fleet-idle excluded: `dispatchblock` blocker until `graphyard unblock GY-N REASON`; older fleet-idle ones (`dispatch-failure`) clear once launchable.

## Review gate: verdicts, not threads

Exact-head approval plus required CI land; threads are inputs, each (thread/comment ID) marked resolved, follow-up (answered nit, never filed; fixes are `BLOCKING`, on that PR) or overridden, else approval withdraws. After two rework rounds bot threads are advisory; past round cap (default 3) only `BLOCKING:` holds, escalating, its rework put to an independent approver (not risk lane); capped requests without one are re-reviewed. Required conversation resolution is drift: `master protection --apply`.

`Nit: PATH:LINE — FINDING` ends `(mechanical: typo|docs-placement|formatting|naming)` or `(substantive: behavior|criteria|scope)`; behaviour/criterion/scope signs or no path mean substantive. Mechanical findings: gate refuses (unless head is bot commit); loop requests a bot `rework`, one commit (or approval-carrying refresh) on the approved head touching only those files. `Rejected bot commit: SHA — reason` with REQUEST_CHANGES records `misclassified-finding` ([intervention](dashboard.md)). Unchanged resubmission or 60 idle minutes: plain nits (`src/mechanical-findings.ts`).

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` bounds `complete`, new heads, landings (see `AGENTS.md`): new files, `tests/helpers/timing-baseline.json` lines for changed or unrecorded tests pass; out-of-scope files three-way merge onto the landing commit (extending or base-only pass; reverts, deletions, rewrites refuse). `evaluateLandability` (`src/model/landability.ts`) is the single authority on landing: non-sticky refusals in required check `graphyard/landable`, never verdict inputs; acceptance (proof) family is unpublished, gating nothing. Pre-push `graphyard sync GY-N` merges `origin/BASE` (no rebase); `graphyard sync GY-N --restore` resets out-of-scope files to base tip, one commit.

CI runs the full suite; workers run build and `graphyard verify GY-N` (own proofs), submit on pass, naming out-of-scope sandbox failures in PR. `leftToCi` (exit 0, `passing`): all passed, abnormal end (hook, crash, signal); failed/skipped/unexecuted block. Passing on the merge base with only test-side files (`*.test.*`, `tests/`, `test/`, `__tests__/`, `fixtures/`): `unexercised`, exit 1, `failing`; tests-only changes unjudged; no base run: `indeterminate`. `--preserves PROOF` exempts regression guards.

### Generated files never conflict

`GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` paths are `generated`: only deletion refuses; `sync` regenerates.

## Ship in under thirty minutes

[Speed](master-agent-reference.md#pipeline-speed), [proofs in CI](github.md#proofs-in-ci). `graphyard diagnose GY-N` names holds; `base-behind`/`base-conflict`: rework or, docs-only, [docs-sync](development.md#documentation-that-rarely-conflicts) (own checkout). Polls save only on a moved submission, candidate, policy or queue tip; three unsaved escalate once (`observation.no-save-escalated`, `observation-starved` attention, `/api/status` `starvedJobs`), retrying every 20 s.

Stalled rows name their remedy (`src/stall-remedies.ts`, else generic): App permission holds run `master browser installation-accept` (`app-permissions` first if needed) once per unchanged run (`POST /api/actions/:id/remedy`), refusals escalate once, unretried; full roles:  `master registry role set ROLE ACCOUNT… --concurrency N` or session ending.
