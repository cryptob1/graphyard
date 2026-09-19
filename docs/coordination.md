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

Work details show required proofs as **unmeasured**, **incomplete**, **failed**, or **passed**. Untrusted assertions and evidence for another head, base, policy, scenario or environment cannot produce a pass. A later matching failure or incomplete run supersedes the earlier pass. The preview uses the same applicability rules as the gate, but only the server authorizes progression.

## Revise requirements explicitly

The human operator can use **Revise requirements** in work details, or:

```sh
graphyard requirements GY-N revision.json
```

Example `revision.json`:

```json
{
  "expectedPolicyRevision": 1,
  "reason": "Retries must preserve exactly-once behavior",
  "criteria": [{"id":"AC-1","text":"Retries produce one SMS request","proofs":["integration:sms-idempotency"]}],
  "dependencies": [],
  "plannedFiles": ["src/booking/", "src/sms/send.ts"],
  "exclusiveResources": ["staging:sms-test-account"]
}
```

The command replaces the full requirements document; omitted criteria are removed, not implicitly retained. Keep the same criterion ID when clarifying the same obligation. Removed IDs are retired and cannot be recycled for unrelated requirements. Dependencies must name existing items and cannot form a cycle.

Stop the worker and release its lease first. Only the human operator's `admin` credential may revise requirements this way (a scoped operator agent may only add); workers cannot weaken their own gates. Concurrent edits compare the expected policy revision. Every successful revision records the authenticated actor, reason, complete requirements and new policy revision in append-only history. Historical snapshots retain previous criteria.

All previous acceptance evidence remains in history but becomes inapplicable to the new policy. Review requests, observations and merge authorization are invalidated. Previously submitted work requires a new claimed attempt and resubmission on its existing PR branch. GitHub check revocation is asynchronous: suspend merging until the refusing check is visible, as with rework. Delivered or observed-merged work requires a follow-up task.

To withdraw specific accepted runs without changing what the work item requires, revoke that evidence instead of revising requirements; see the [operations reference](operations-reference.md#accepted-evidence-turns-out-to-be-wrong) and the [protocol](protocol/evidence.md#revocation).

Existing E2E proof names retain their pinned scenario version. Newly added E2E proofs pin the latest definition at revision time. This command does not silently upgrade existing pins. Selecting a newer revision of the same scenario and selective reuse of unaffected evidence remain future work.

## Detect overlap without pretending to understand every API

`plannedFiles` can contain exact repository-relative paths or directory prefixes ending in `/`, `/*`, or `/**`. All three directory forms include descendants, for overlap warnings and for the [regression guard](#refuse-candidates-that-revert-shipped-code-outside-their-scope) alike. Arbitrary glob expressions, renames across historical paths, generated-file relationships and semantic dependencies are not inferred.

Graphyard compares planned paths and provider-observed PR files against other unfinished ready, assigned or submitted work. Cards show the other work keys; details show the overlapping scopes. Backlog-only peers are omitted until scheduled. Warnings may use the last observed diff; they are not proof of current filesystem contents. Overlap does not block a claim: two compatible edits may legitimately touch the same file. Coordinate or add an explicit dependency when ordering is required.

## Reserve explicitly shared resources

Optional `exclusiveResources` names declare resources that cannot be assigned concurrently, such as `staging:sms-test-account`. Names are case-sensitive lowercase identifiers using letters, digits, `.`, `_`, `:`, `/`, and `-`. Give the same real resource the same name throughout this single-repository installation.

Claiming work atomically reserves all declared names for that assignment. A conflicting active assignment refuses the whole claim. `next` and master dispatch exclude work with busy resources. Reservations normally follow the worker lease: release or expiry makes them claimable again, and an old heartbeat cannot recover expired authority. If an assignment has a containment quarantine, however, all of its declared resources remain reserved after lease expiry. They become available only after the quarantine is cleared: by verified capability settlement, by a coordinator that verified the supervisor dead on the registered host ([automatic containment settlement](protocol/containment-settlement.md)), or by the human operator's confirmed stopped-worker recovery. Rework performs that recovery for undelivered work and authorizes reassignment. On delivered work, capability settlement or `recover-containment --previous-worker-stopped` removes only the quarantine and releases its resource fence. It appends required audit/revision metadata without re-evaluating stale observation or evidence, preserving Done, recorded gates, candidate, evidence, observation, merge authorization, and the delivery snapshot. Non-delivered settlement retains normal gate evaluation. Submission alone does not release an active lease.

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

It runs `git fetch origin && git merge origin/BASE` — a merge, never a rebase, so the history and every resolution stay visible — and then classifies the local diff against the fetched base tip with the same rules. It prints every offending file and exits non-zero before anything is pushed; a conflicting merge stops with the conflicted paths and no resolution is made for the worker. The generated `AGENTS.md` block requires `sync` before every push and states that files outside `plannedFiles` must match `origin/BASE` byte-for-byte. Restoring a file is `git checkout BASE_TIP -- PATH`; for a rename, restore the original path.

The scope is the human operator's. A worker cannot widen `plannedFiles`: the `workspace`, `submit` and `evidence` commands never accept it, and only the audited [`requirements` revision](#revise-requirements-explicitly) changes it. A master that asks the human operator to return a refused candidate for rework (rework stays `admin` only) should quote the refusal's file list in the rework reason and ask the worker to run `sync GY-N` and restore each file rather than re-resolve the merge.

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
