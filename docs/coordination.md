<!-- page: Operate Graphyard | 10 | criteria, scope. -->
# Coordination

## Write observable criteria

Criterion: `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. `unit:`/`integration:`: producer-runnable on exact head ([dispatch](master-agent.md#automatic-dispatch-at-submit)); `manual:`: two-party attestation unless in `producerProofs`, judged, not title-counted; `e2e:`: [runner](validation.md). Any trusted pass proves it whatever it executed (`unit:`/`integration:`/`e2e:` need `executed > 0`). `master create` plans; `master requirements GY-N revision.json "REASON"` adds; rewrite/removal/narrowing: two-party `master decide GY-N requirements @revision.json "REASON"`. Revisions replace the document (`expectedPolicyRevision`), lapsing evidence/review/authorization. Non-widening requirements decisions approved under live lease/fence are `held`, applied at attempt end (submitted heads re-reviewed), grounding scope asks; never re-request. Covering ([scope waits](master-agent-reference.md#items-scope-and-human-waits)). Post-ship/production/live-install/host outcomes (intervention-pattern rates too), any proof, need `manual:post-deploy/NAME` (beside buildable criterion) or this head's per-clause observation, else refused; never merge-gating; verify-deployment files per-proof follow-ups lacking trusted post-merge passes (served release's CLI, else waits). `observationWindow.notBefore` (streak-start+hold, merge+days, first-serving+hours, unfiled→server-derived; `defer GY-N EPOCH ISO REASON`; unleased: `master defer GY-N ISO REASON`, loop-applied to observation-wait blockers; ≤30d) holds dispatch+claim, never Blocked.

## Dispatch optimistically, smallest scope first

`plannedFiles` (paths, `/`-ending prefixes) scope, never lock: `sync` and GitHub's [merges](delivery.md#one-delivery-path) integrate overlaps (`master status`: `overlap.concurrent`, `merge-tree` failures). Root-level directories (`highConflict`) need `--allow-broad-scope`; only `exclusiveResources` (claim-reserved) hold dispatch. Asks fold past 20 new files/directory or the cap; asked files and fold directories need no creating criterion, even quarantined; misspelt planned/proof-named tests: refused, naming it. Authoring plans `unit:`/`integration:`/`manual:fault-class-*` proof tests and the wall-clock gate (`master create`, fault-class filing); docs and whole `verification/AREA.md` maps whose `Paths:` cover planned files or self-grounded, gate-free tests stay widen-time.

`worktree GY-N EPOCH` detaches earlier worktrees (`workspace.preserved`), removes abandoned (`reclaimed`); failing, releases the claim. Unacknowledged reviewer/producer launches fail at start-bound+120s. Lease-less idle/done Herdr sessions launch. **3** single-cause failures, fleet-idle excluded: `dispatchblock` until `graphyard unblock GY-N REASON`; older fleet-idle (`dispatch-failure`) clear once launchable.

## Review gate: verdicts, not threads

Exact-head approval plus required CI land; threads (inputs), each resolved, follow-up (answered nit, unfiled) or overridden, else approval withdraws. Past two rework rounds bot threads advise; past cap (default 3) only `BLOCKING:` holds, rework to independent approver (not lane); others withdrawn, re-reviewed; refused (unbound: escalated): owed rework cancelled, re-review with refusal, FOLLOW-UP; repeats escalate (`master decide rework`); second refusal re-withdraws; status names the stalled review-cap step. Required conversation resolution: drift, `master protection --apply`. Control-plane: sensitive needs exact-head approval; normal merges, post-merge review files `BLOCKING:` bugs. Control-plane mode switches off plannedFiles/scope refusals, sync restore, scope hook, producer sessions, budget-test blockers, normal-risk rework approvers. Rework quotes decision reasons; unread refuses launch; held: refused on unmoved, unclaimed heads; reauthorizations lapse once submitted.

`Nit: PATH:LINE — FINDING` ends `(mechanical: typo|docs-placement|formatting|naming)` or `(substantive: behavior|criteria|scope)`; behaviour/criterion/scope signs or no path: substantive. Mechanical findings: gate holds on a planned fix only (bot-commit heads excepted); loop requests bot `rework`, one commit on approved head, only those files. `Rejected bot commit: SHA — reason` with REQUEST_CHANGES records `misclassified-finding` ([intervention](dashboard.md)). Unchanged resubmission or 60 idle minutes: nits.

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` bounds `complete`, new heads, landings: new files, `tests/helpers/timing-baseline.json` lines for changed or unrecorded tests pass; out-of-scope files three-way merge onto landing commit (extending/base-only pass; reverts, deletions, rewrites refuse). `evaluateLandability`, landing's single authority: non-sticky refusals in required check `graphyard/landable`, never verdict inputs; acceptance (proof) family unpublished, gating nothing. Pre-push `graphyard sync GY-N` merges `origin/BASE`; `--restore` resets out-of-scope files to base, one commit. Claude `PreToolUse` hook `graphyard scope-guard GY-N EPOCH` exits 2 on edits `complete` refuses, naming `scope-request GY-N EPOCH PATH --wait -- REASON`. Control-plane: failing post-merge `advisoryTests` file one chore.

Workers build, run request-named fast gates (tests/module-budgets.test.ts, tests/docs-budget.test.ts, tests/docs-growth-gate.test.ts, tests/docs-glossary.test.ts, tests/no-wall-clock-time-bombs.test.ts, tests/ci-shards.test.ts, scripts/check-docs.mjs) and `graphyard verify GY-N` (own proofs; CI: all), submit on pass, naming out-of-scope sandbox failures. `leftToCi` (exit 0, `passing`): all passed, abnormal end; failed/skipped/unexecuted block. Passing on merge base, test-side files only: `unexercised`, `failing`; tests-only unjudged; no base run: `indeterminate`. `--preserves PROOF` exempts regression guards.

### Generated files never conflict

`GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` paths are `generated`: only deletion refuses; `sync` regenerates.

## Ship in under thirty minutes

[Speed](master-agent-reference.md#pipeline-speed), [CI proofs](github.md#proofs-in-ci). `graphyard diagnose GY-N` names holds; `base-behind`/`base-conflict`: rework or, docs-only, [docs-sync](development.md#documentation-that-rarely-conflicts). Polls save only on moved submission/candidate/policy/queue tip; three unsaved escalate (`observation-starved`).

App-permission holds run `master browser installation-accept` (`app-permissions` first) once/run; refusals escalate once; roles: `master registry role set ROLE ACCOUNT… --concurrency N`.
