<!-- page: Operate Graphyard | 8 | dependencies, requirement revisions, overlap, and shared resources. -->
# Coordinating independent agents

Graphyard owns assignment authority and evidence admissibility. Herdr owns session processes. Git owns source history. This guide describes the shipped coordination features; the two-host operational trial is still a separate validation task. Terms follow the [glossary](glossary.md).

## Start with an observable requirement

A criterion states an outcome and names one or more required proofs. For example:

```json
{
  "id": "AC-1",
  "text": "Retrying a confirmed booking produces exactly one SMS request",
  "proofs": ["integration:sms-idempotency", "e2e:confirmed-booking-sms"]
}
```

The repository's tests define the actual assertions. Graphyard checks evidence identity, version, result and execution counts; it does not independently understand booking semantics. Register an E2E scenario before referring to it. A configured proof name alone does not establish a trusted producer: authorize the reporter separately as described in the [protocol](protocol/evidence.md).

Every `unit:` and `integration:` proof is producer-runnable: when the candidate passes the build gate the control plane requests a producer session for each proof group and the master loop launches it on the exact head (see [automatic dispatch at submit](master-agent.md#automatic-dispatch-at-submit)). A `manual:` proof is attested through a two-party `attest` decision (the master requests, the approver agent approves; see [two-party decisions](operator-automation.md#two-party-decisions)) unless the item lists it in `producerProofs` (on `create` and in a `requirements` revision), which marks it producer-runnable and adds it to the `manual` group; `e2e:` proofs run through the validation runner. A criterion's proof names never change meaning through that list — it only says who may run them.

Work details show required proofs as **unmeasured**, **incomplete**, **failed**, or **passed**. Untrusted assertions and evidence for another head, base, policy, scenario or environment cannot produce a pass. A later matching failure or incomplete run supersedes the earlier pass. The preview uses the same applicability rules as the gate, but only the server authorizes progression.

## Revise requirements explicitly

The master revises requirements as an agent decision. Adding requirements needs only its operator-agent identity; a revision that rewrites, removes or narrows anything is a two-party decision the approver agent approves:

```sh
graphyard master requirements GY-N revision.json "REASON"            # additions only
graphyard master decide GY-N requirements @revision.json "REASON"   # rewrites and removals
graphyard master approver GY-N DECISION                            # the independent approver
```

A declared human `admin` session may still use **Revise requirements** in work details or `graphyard requirements GY-N revision.json`.

Example `revision.json`:

```json
{
  "expectedPolicyRevision": 1,
  "reason": "Retries must preserve exactly-once behavior",
  "criteria": [{"id":"AC-1","text":"Retries produce one SMS request","proofs":["integration:sms-idempotency"]}],
  "dependencies": [],
  "plannedFiles": ["src/booking/", "src/sms/send.ts"],
  "exclusiveResources": ["staging:sms-test-account"],
  "producerProofs": []
}
```

The command replaces the full requirements document; omitted criteria are removed, not implicitly retained, and an omitted `producerProofs` leaves every manual proof to an `attest` decision. Keep the same criterion ID when clarifying the same obligation. Removed IDs are retired and cannot be recycled for unrelated requirements. Dependencies must name existing items and cannot form a cycle.

Stop the worker and release its lease first. An operator agent alone may only add; a rewrite or removal applies only after an independent approver agent approves it (and still raises the `requirement-weakening` escalation, resolved by a second two-party decision), or when a declared human `admin` session makes it; workers cannot weaken their own gates. Concurrent edits compare the expected policy revision. Every successful revision records the authenticated actor, reason, complete requirements and new policy revision in append-only history. Historical snapshots retain previous criteria.

All previous acceptance evidence remains in history but becomes inapplicable to the new policy. Review requests, observations and merge authorization are invalidated. Previously submitted work requires a new claimed attempt and resubmission on its existing PR branch. GitHub check revocation is asynchronous: suspend merging until the refusing check is visible, as with rework. Delivered or observed-merged work requires a follow-up task.

To withdraw specific accepted runs without changing what the work item requires, revoke that evidence instead of revising requirements; see the [operations reference](operations-reference.md#accepted-evidence-turns-out-to-be-wrong) and the [protocol](protocol/evidence.md#revocation).

Existing E2E proof names retain their pinned scenario version. Newly added E2E proofs pin the latest definition at revision time. This command does not silently upgrade existing pins. Selecting a newer revision of the same scenario remains future work. Reuse of an executed pass for a later head of the same item is a separate, policy-bound decision described in [evidence replay, scoped reuse and execution analytics](evidence-reuse.md); a requirement revision always refuses it.

## Detect overlap without pretending to understand every API

`plannedFiles` can contain exact repository-relative paths or directory prefixes ending in `/`, `/*`, or `/**`. All three directory forms include descendants, for overlap warnings and for the [regression guard](#refuse-candidates-that-revert-shipped-code-outside-their-scope) alike. Arbitrary glob expressions, renames across historical paths, generated-file relationships and semantic dependencies are not inferred.

Graphyard compares planned paths and provider-observed PR files against other unfinished ready, assigned or submitted work. Cards show the other work keys; details show the overlapping scopes. Backlog-only peers are omitted until scheduled. Warnings may use the last observed diff; they are not proof of current filesystem contents. Overlap does not block a claim: two compatible edits may legitimately touch the same file. Coordinate or add an explicit dependency when ordering is required.

### Schedule by overlap, smallest scope first

Overlap does block *dispatch*, advisorily. Whichever of two overlapping candidates lands second re-integrates the first through a sync → review → proof round, so the master treats an item's `plannedFiles` as a soft exclusive resource against every item that is claimed (a live lease, or a containment quarantine still holding its assignment) or submitted but not merged:

- `master dispatch` and the durable master loop refuse to dispatch an item that overlaps such an item. The refusal, and the item's row in `master status`, name the item ahead, whether it is claimed or submitted, and the overlapping paths on both sides. A ready item nobody has claimed holds nothing; two ready items that overlap are ordered, and the first dispatched then holds the other. Delivered work and an expired lease hold nothing.
- The hold is advisory with an operator override: `master dispatch GY-N PROFILE --allow-overlap` dispatches anyway and records the overlap in its result. The loop never uses the override. Exclusive resources, dependencies, blockers and quarantines refuse exactly as before; `--allow-overlap` lifts nothing else.
- Ready items dispatch smallest planned scope first within an operator priority: fewest root-level directory scopes (`src/`, `docs/`, `tests/`, `/`), then fewest directory scopes, then fewest exact files, then the older item. A root-level directory scope is flagged `highConflict` in `master status`: it overlaps nearly everything, so narrow it before building it beside other work.
- For every open candidate, `master status` also reports the other open candidates git itself cannot merge it with (`git merge-tree` over the fetched PR heads), the conflicting files per pair, and a fewest-conflicts-first merge sequence. See [the master guide](master-agent.md#conflict-avoidance).

## Reserve explicitly shared resources

Optional `exclusiveResources` names declare resources that cannot be assigned concurrently, such as `staging:sms-test-account`. Names are case-sensitive lowercase identifiers using letters, digits, `.`, `_`, `:`, `/`, and `-`. Give the same real resource the same name throughout this single-repository installation.

Claiming work atomically reserves all declared names for that assignment. A conflicting active assignment refuses the whole claim. `next` and master dispatch exclude work with busy resources. Reservations normally follow the worker lease: release or expiry makes them claimable again, and an old heartbeat cannot recover expired authority. If an assignment has a containment quarantine, however, all of its declared resources remain reserved after lease expiry. They become available only after the quarantine is cleared: by verified capability settlement, by a coordinator that verified the supervisor dead on the registered host ([automatic containment settlement](protocol/containment-settlement.md)), or by a confirmed stopped-worker recovery: a two-party `rework` or `recover` decision the approver agent approves, or the same command from an `admin` session. Rework performs that recovery for undelivered work and authorizes reassignment. On delivered work, capability settlement or `recover-containment --previous-worker-stopped` removes only the quarantine and releases its resource fence. It appends required audit/revision metadata without re-evaluating stale observation or evidence, preserving Done, recorded gates, candidate, evidence, observation, merge authorization, and the delivery snapshot. Non-delivered settlement retains normal gate evaluation. Submission alone does not release an active lease.

These are coordination reservations, not physical locks on an external account or environment. A disconnected process may still access external systems using its credentials. Use supervised workers and verify that the old process has stopped before touching shared resources. Runner-specific resource fencing and leases spanning independent E2E execution are part of future runner orchestration. Never treat a resource name as a substitute for an access-control boundary.

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` is also the boundary of what a candidate may change. A worker session that merges the base branch and re-resolves a file it does not own in favour of its branch silently deletes code and tests that already merged, and an independent reviewer is a slow and unreliable way to notice. Graphyard catches it at `complete`, before review, and again on every new head:

- Every file the pull request changes is classified against the work item's `plannedFiles`. Changes strictly inside scope pass, and so do new files nobody has shipped.
- Every other file is compared with the commit the candidate is bound to — the base branch tip, or the predicted base of a published speculative tip — by blob identity. A file that matches byte-for-byte passes. A file that is deleted, reverted (lines removed and nothing added), rewritten, renamed away from a shipped path, or a binary that differs is refused. A file the observation could not compare is refused too; absence of evidence is never a pass.
- `complete` observes the pull request first and refuses the submission with the exact file list and the delivered work items whose planned files or observed diff shipped each path. Nothing is recorded for a refused submission. Once the submission is accepted, every reconciliation re-derives the same refusal for the current head into the `build` gate, the `Graphyard / merge` check, `diagnose` (`gate-build` entries) and the work detail drawer, so a bad merge pushed during rework is caught the same way.

Workers keep the base branch current with `sync`:

```sh
graphyard sync GY-N
```

It runs `git fetch origin && git merge origin/BASE` — a merge, never a rebase, so the history and every resolution stay visible — regenerates the repository's [generated files](#generated-files-never-conflict) from the merged sources, commits the merge, and then classifies the local diff against the fetched base tip with the same rules. It prints every offending file and exits non-zero before anything is pushed. A conflicting merge stops with the remaining conflicted paths, each naming the shipped work items that landed it (the delivered items whose merge commits the sync brought in and whose planned scope or observed diff covers the path; when none of those covers it, every delivered item that ever shipped the path), and no hand resolution is made for the worker: resolve each, stage it, and rerun `sync` — it continues the merge it left, regenerates the generated files from the resolved sources, and commits. The generated `AGENTS.md` block requires `sync` before every push and states that files outside `plannedFiles` must match `origin/BASE` byte-for-byte. Restoring a file is `git checkout BASE_TIP -- PATH`; for a rename, restore the original path.

### Generated files never conflict

Two shared files changed in nearly every pull request and conflicted trivially: the docs indexes in `docs/README.md` and `docs/protocol.md`, and the managed `AGENTS.md` blocks. They are generated, so nobody merges them by hand:

- `docs/README.md` and `docs/protocol.md` are rendered in full by `npm run docs:check -- --write` from each page's `<!-- page: Section | order | summary -->` line — the prose around the index lives in `scripts/check-docs.mjs`, and the file's first lines say it is generated. `npm run docs:check` fails in CI when either is stale or missing, and `node scripts/check-docs.mjs --manifest` prints their paths, which is how `sync` learns what to regenerate. A conflict in one of them is resolved by regeneration from the merged pages; after any merge, clean or not, `sync` regenerates them and commits the result, so a numbered section renumbered by two additions never lands stale.
- The managed `AGENTS.md` blocks are rendered by `graphyard init` and `master init`. `tests/generated-index.test.ts` asserts that the committed `AGENTS.md` carries exactly what the templates in the tree render, so drift is caught by the test rather than by a committed regeneration in every unrelated pull request. When the blocks conflict and their template sources did not, `sync` re-renders them around the hand-written text — with the templates the merged tree carries in Graphyard's own repository, otherwise with the CLI's — and leaves any conflict outside the blocks to the worker.
- The regression guard classifies a generated file as `generated` rather than as an out-of-scope rewrite, so an item that adds a page no longer needs the index in its `plannedFiles`. The control plane learns the set from the deployment variable `GRAPHYARD_GENERATED_FILES`, a comma-separated list of exact repository-relative paths that must match the repository's manifest — for this repository, `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md`. Unset, the guard is unchanged: a managed repository whose `docs/README.md` is hand-written keeps it protected. Deleting a generated file is still a deletion and is refused; `sync` applies the same classification locally from the manifest. Nothing else about the out-of-scope rule changes.

The scope is set by the item's requirements, not by its worker. A worker cannot widen `plannedFiles`: the `workspace`, `submit` and `evidence` commands never accept it, and only the audited [`requirements` revision](#revise-requirements-explicitly) changes it. A master returning a refused candidate for rework requests a two-party `rework` decision (`graphyard master decide GY-N rework "REASON"`), quotes the refusal's file list in the reason, and asks the worker to run `sync GY-N` and restore each file rather than re-resolve the merge.

## Explain stalls

```sh
graphyard diagnose GY-N
```

The CLI and work detail drawer explain dependencies, explicit blockers, missing ownership or workspace, busy resources, unobserved/stale PRs, integration failures, overdue unowned integration jobs, violations and the first refusing gate, including an [out-of-scope regression](#refuse-candidates-that-revert-shipped-code-outside-their-scope) refusal with its file list. A submitted head that does not contain the base branch tip is reported as `base-behind`: no review is requested for it until the worker runs `graphyard sync` or the merge queue publishes a tip that contains the base. For a queued candidate, `queue-binding-carried` and `queue-binding-required` say per binding — the approval and each required proof — whether it was carried across Graphyard's authored tip or must be produced afresh, each with the recorded reason, and `queue-base-carried` reports a tree-identical base advance the binding survived; see [the merge queue](github.md#binding-carry-across-a-graphyard-authored-tip). Output includes required proof and file overlap. Work, job metadata and database time come from one snapshot. This is diagnostic evidence, not another lifecycle state setter.

Released and expired assignments are described as no longer authoritative; the UI does not invent a cause or claim the process has terminated. Integration errors retain automatic retry information. Missing observation and unavailable connectivity must not be interpreted as successful delivery.

## Two-machine operational drill

Run this with two real hosts, two distinct worker principals, and the human operator. Isolated tests using independent connection pools are useful but are **not** evidence that this drill ran. The trusted [`integration:herdr-recovery` contract](herdr.md#automated-recovery-contract) proves the same refusals automatically, but it is evidence about the coordination API, not about two real hosts.

1. Connect both hosts with `graphyard init --herdr --token-stdin`; check distinct host IDs and principal IDs. Keep `admin` and `producer` credentials off both worker environments.
2. Create a small real work item with a repository test as its acceptance proof. Concurrently claim it from both hosts. Record one winner and one refusal, then register the winner's worktree.
3. Run the winner through `watch`. Interrupt its connection to Graphyard while retaining logs. Confirm the supervisor terminates its child before treating the host as stopped.
4. After server-clock lease expiry, claim from the other host. Record the higher epoch and fresh registered workspace. Preserve the first workspace for inspection.
5. Restore the first connection. Try its old-epoch heartbeat, workspace registration and submission. All must refuse. Do not push old work; Graphyard cannot revoke independent Git credentials through a lease.
6. Implement and submit from the new owner. Push another commit after an independent review and confirm the previous approval/evidence no longer authorizes the new head.
7. Exercise duplicate and delayed provider deliveries and a temporary integration outage. Confirm the job recovers without duplicate authority or a stale pass. Avoid disabling protection on the production repository.
8. Finish through normal review and gates, record both host identities, epochs, timestamps, sanitized logs, CI and PR URLs, and the observer's result. Record failures honestly; do not mark the drill complete based on this checklist.

The current implementation is still through-merge coordination. Verified production delivery and automatic runner orchestration require the next delivery work.

After a requirement or review-provider revision, Graphyard captures every GitHub review identity in the first complete provider observation as a fixed baseline. Approvals present in that observation cannot authorize the revised work; request another formal review after the baseline is captured. Only a new review identity, independent author and matching current head may count. The first snapshot is deliberately conservative: even a review submitted after the revision but before baseline collection is excluded. Missing review identities refuse. Provider/database clock skew cannot make an excluded review become fresh later. Codex continues to use its new candidate/policy-bound request. Switching providers resets the formal baseline.
