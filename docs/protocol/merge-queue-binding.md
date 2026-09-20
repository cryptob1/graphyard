<!-- page: Agent protocol | 8 | base binding and carry. -->
# Merge-queue bindings and carry

For an integration author: what a candidate is bound to.

## The observed base

Every observation reads the managed branch from `refs/heads/<base>` and records:

- `observation.baseTip`: Branch head sha. Never the pull request's cached `base.sha`.
- `observation.baseTree`: That commit's tree.
- `observation.baseTipContained`: Head contains `baseTip`: by ancestry, or as a published queue tip whose bound base is tree-identical to it or which sits behind other queue entries.
- `candidate.baseSha`: Bound base: predicted base of a published speculative tip for this head under this policy revision; otherwise the base the head was already bound to while behind `baseTip` and the branch still contains that commit ([base refresh](#base-refresh)); otherwise `baseTip`.

Review is requested only while `baseTipContained` is not `false`:

- **`master review`:** refuses with `does not contain the base branch tip`.
- **`codex` and `agent` dispatchers:** defer.
- **`diagnose`:** `base-behind`.

A wait of seconds: the control plane republishes the head itself; the request goes to what it publishes.

## Base refresh

A candidate outside the queue whose head no longer contains `baseTip` is brought onto it by the control plane, not a rework round.

- **Reconciliation job:** merges the base branch into the pull-request branch with the same conflict-free provider merge (Contents: write, no ref of its own), once per head, base tip and policy revision, leaving a queued entry to its own speculative tip.
- **Bound base:** held while that is pending, so bindings made on the unchanged tree stand; the hold ends when the head contains the tip, a rewound branch no longer contains the held commit, or on conflict.

The record gains `baseRefresh`:

- `from`: Head the refresh acted on; base it was bound to.
- `base`, `baseTree`: Base-branch tip it was brought onto; that commit's tree.
- `head`: Republished head, or `null` when the merge conflicted.
- `conflict`: Why the base could not be merged in, named for the worker; `null` on success.
- `merge`: GitHub's account of the commit, as `queue.speculation.merge` below. `carry`: carry decision, by the rule below, base branch as predecessor.

Required CI checks never carry, here or anywhere: the republished head is a different tree, so they run on it.

- **Ledger:** `base.refreshed` or `base.conflict` with carry summary, `base.carry` with the full decision.
- **`master run`:** `refresh` action per head and base tip.
- **Conflict:** writes nothing (no commit, no ref, no carried binding). The build gate names it, the item returns to `build`, the released hold invalidates approval and every proof: resolving a conflict is content nobody reviewed.

## Evidence `scopeFiles`

Evidence submission may declare paths the proof depends on:

```json
{ "proof": "unit:queue", "sha": "…", "baseSha": "…", "policyRevision": 1, "result": "pass", "executed": 3, "skipped": 0,
  "scopeFiles": ["src/merge-queue.ts", "src/model/", "tests/"] }
```

## Tree-identical base advances

When the entry ahead merges, the base branch becomes a merge commit whose tree equals the tip the follower was validated on.

- **Follower:** binds by tree (`binding: "tree-equivalent"` in `master status`), keeps its published tip, candidate, review and evidence bindings, neither republishes nor moves the pull request branch.
- **Record:** `queue.speculation.carriedBase` (`sha`, `tree`, `at`).
- **Ledger:** `queue.base-carried` event with `tip`, `boundBase`, `baseTree`, `baseTip`.

## Carry across a Graphyard-authored tip

Publishing a tip for an entry not already on its predicted base merges that base into the pull request branch; the same rule decides a base refresh, with base branch as predecessor (`predecessor: "base branch"`, always validated) and `baseChanges` taken between the head's bound base and the branch tip. The speculation records `merge`:

- `from`: Replaced head.
- `parents`, `author`, `authoredByApp`: GitHub's account of the tip.
- `conflicts`: Always `false` for the provider merge: it refuses a conflict with `409`, ejecting the entry.
- `baseChanges`: Paths changed between the replaced head's bound base and the predicted base; `null` when GitHub could not list them completely: the compare API reports first-page files only and stops at 300.

Binding the tip decides once and records `queue.speculation.carry`:

- `from`, `to`: Replaced head and its bound base; tip and its predicted base.
- `predecessor`: Entry whose tip is the predicted base, or `base branch`.
- `changedFiles`: `merge.baseChanges`. `reviewedFiles`: what the review read: files the replaced head changed.
- `approval`: `carried: true` with `provider`, `reviewer`, `reviewId`, `reviewerApp`, `originalSha` and the reason, or `carried: false` with the reason.
- `evidence[]`: Per required proof: `carried`, the `evidenceId` and `producer` it names, the reason.

Nothing carries unless the tip is a two-parent merge of exactly `from.sha` and `to.baseSha`, authored by the control-plane App through the conflict-free merge, over a predecessor whose own gates all pass on that tip, with a complete change list. Within that:

- **Approval:** carries when no reviewed file changed.
- **Proof:** carries when its declared scope is disjoint from the change.
- **Every other case:** `carried: false` naming what was touched.
- **Carried record:** named by its `evidenceId`, so one carried twice stays the record the latest decision names.
- **Carried binding:** holds only while the candidate is exactly `to` under the same policy revision (and, for agent review, the same reviewer App); revoking the original evidence withdraws it and ejects the tip.
- **Ledger:** one `queue.carry` event per decision, a `carried`/`required` summary on `queue.predicted`.

GitHub dismisses stale reviews on Graphyard's own tip push, so before acquiring merge authority `master merge` re-posts a carried approval bound to the tip through the reviewer App that gave it (never the control-plane App, never a human reviewer's approval, never over a reviewer that has since requested changes), reported as `carriedApproval`.

## Where it is reported

- **`GET /api/work-snapshot`:** `queue.speculation.merge`, `.carry`, `.carriedBase`, `baseRefresh`, `observation.baseTip`, `.baseTree`, `.baseTipContained`.
- **`master status`:** each `queue[]` entry's `binding` (`base` with bound sha and tree, `binding`, `carriedTo`; `approval` and `evidence[]` as `exact`, `carried` or `required` with the reason) and each work row's `base` for a pending refresh, conflict or last refresh's carry.
- **`diagnose GY-N`:** `base-behind`, `base-conflict`, `base-refresh-carried`, `base-refresh-required`, `queue-base-carried`, `queue-binding-carried`, `queue-binding-required`.
