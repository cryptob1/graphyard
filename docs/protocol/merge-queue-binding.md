<!-- page: Agent protocol | 8 | base binding and carry. -->
# Merge-queue bindings and carry

For an integration author: what a candidate is bound to.

## The observed base

Every observation reads the managed branch from `refs/heads/<base>` and records:

- `observation.baseTip`: The branch head sha. Never the pull request's cached `base.sha`.
- `observation.baseTree`: That commit's tree.
- `observation.baseTipContained`: The head contains `baseTip`: by ancestry, or as a published queue tip whose bound base is tree-identical to it or which sits behind other queue entries.
- `candidate.baseSha`: The bound base: the predicted base of a published speculative tip for this head under this policy revision; otherwise the base the head was already bound to while it is behind `baseTip` and the branch still contains that commit ([base refresh](#base-refresh)); otherwise `baseTip`.

A review is requested only while `baseTipContained` is not `false`:

- **`master review`:** refuses with `does not contain the base branch tip`.
- **`codex` and `agent` dispatchers:** defer.
- **`diagnose`:** `base-behind`.

A wait of seconds: the control plane republishes the head itself and the request goes to what it publishes.

## Base refresh

A candidate outside the queue whose head no longer contains `baseTip` is brought onto it by the control plane, not a rework round.

- **Reconciliation job:** merges the base branch into the pull-request branch with the same conflict-free provider merge (Contents: write, no ref of its own), once per head, base tip and policy revision, leaving a queued entry to its own speculative tip.
- **Bound base:** held while that is pending, so bindings made on the unchanged tree stand; the hold ends when the head contains the tip, when a rewound branch no longer contains the held commit, or on a conflict.

The record gains `baseRefresh`:

- `from`: The head the refresh acted on and the base it was bound to.
- `base`, `baseTree`: The base-branch tip it was brought onto, and that commit's tree.
- `head`: The republished head, or `null` when the merge conflicted.
- `conflict`: Why the base could not be merged in, named for the worker; `null` on success.
- `merge`: GitHub's account of the commit, as `queue.speculation.merge` below. `carry`: the carry decision, by the rule below, with the base branch as the predecessor.

Required CI checks never carry, here or anywhere: the republished head is a different tree, so they run on it.

- **Ledger:** `base.refreshed` or `base.conflict` with the carry summary, and `base.carry` with the full decision.
- **`master run`:** a `refresh` action per head and base tip.
- **Conflict:** writes nothing (no commit, no ref, no carried binding). The build gate names it, the item returns to `build`, the released hold invalidates the approval and every proof: resolving a conflict is content nobody reviewed.

## Evidence `scopeFiles`

An evidence submission may declare the paths the proof depends on:

```json
{ "proof": "unit:queue", "sha": "…", "baseSha": "…", "policyRevision": 1, "result": "pass", "executed": 3, "skipped": 0,
  "scopeFiles": ["src/merge-queue.ts", "src/model/", "tests/"] }
```

## Tree-identical base advances

When the entry ahead merges, the base branch becomes a merge commit whose tree equals the tip the follower was validated on.

- **Follower:** binds by tree (`binding: "tree-equivalent"` in `master status`), keeps its published tip, candidate, review and evidence bindings, neither republishes nor moves the pull request branch.
- **Record:** `queue.speculation.carriedBase` (`sha`, `tree`, `at`).
- **Ledger:** `queue.base-carried` event with `tip`, `boundBase`, `baseTree` and `baseTip`.

## Carry across a Graphyard-authored tip

Publishing a tip for an entry not already on its predicted base merges that base into the pull request branch; the same rule decides a base refresh, with the base branch as the predecessor (`predecessor: "base branch"`, always validated) and `baseChanges` taken between the head's bound base and the branch tip. The speculation records `merge`:

- `from`: The replaced head.
- `parents`, `author`, `authoredByApp`: GitHub's account of the tip.
- `conflicts`: Always `false` for the provider merge, which refuses a conflict with `409` and ejects the entry.
- `baseChanges`: The paths changed between the replaced head's bound base and the predicted base; `null` when GitHub could not list them completely: the compare API reports first-page files only and stops at 300.

Binding the tip decides once and records `queue.speculation.carry`:

- `from`, `to`: The replaced head and its bound base; the tip and its predicted base.
- `predecessor`: The entry whose tip is the predicted base, or `base branch`.
- `changedFiles`: `merge.baseChanges`. `reviewedFiles`: what the review read, the files the replaced head changed.
- `approval`: `carried: true` with `provider`, `reviewer`, `reviewId`, `reviewerApp`, `originalSha` and the reason, or `carried: false` with the reason.
- `evidence[]`: Per required proof: `carried`, the `evidenceId` and `producer` it names, and the reason.

Nothing carries unless the tip is a two-parent merge of exactly `from.sha` and `to.baseSha`, authored by the control-plane App through the conflict-free merge, over a predecessor whose own gates all pass on that tip, with a complete change list. Within that:

- **Approval:** carries when no reviewed file changed.
- **Proof:** carries when its declared scope is disjoint from the change.
- **Every other case:** `carried: false` naming what was touched.
- **Carried record:** named by its `evidenceId`, so one carried twice stays the record the latest decision names.
- **Carried binding:** holds only while the candidate is exactly `to` under the same policy revision (and, for agent review, the same reviewer App); revoking the original evidence withdraws it and ejects the tip.
- **Ledger:** one `queue.carry` event per decision and a `carried`/`required` summary on `queue.predicted`.

GitHub dismisses stale reviews on Graphyard's own tip push, so before acquiring merge authority `master merge` re-posts a carried approval bound to the tip through the reviewer App that gave it (never the control-plane App, never a human reviewer's approval, never over a reviewer that has since requested changes), reported as `carriedApproval`.

## Where it is reported

- **`GET /api/work-snapshot`:** `queue.speculation.merge`, `.carry`, `.carriedBase`, `baseRefresh`, `observation.baseTip`, `.baseTree`, `.baseTipContained`.
- **`master status`:** each `queue[]` entry's `binding` (`base` with bound sha and tree, `binding`, `carriedTo`; `approval` and `evidence[]` as `exact`, `carried` or `required` with the reason) and each work row's `base` for a pending refresh, a conflict or the last refresh's carry.
- **`diagnose GY-N`:** `base-behind`, `base-conflict`, `base-refresh-carried`, `base-refresh-required`, `queue-base-carried`, `queue-binding-carried` and `queue-binding-required`.
