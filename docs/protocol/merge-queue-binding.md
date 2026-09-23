<!-- page: Agent protocol | 8 | binding, carry. -->
# Merge-queue bindings and carry

For an integration author: what a candidate is bound to.

## The observed base

Every observation reads the managed branch from `refs/heads/<base>`, recording:

- `observation.baseTip`: Branch head sha. Never the pull request's cached `base.sha`.
- `observation.baseTree`: That commit's tree.

Review is requested only while `baseTipContained` is not `false`:

- **`master review`:** refuses with `does not contain the base branch tip`.
- **`codex` and `agent` dispatchers:** defer.
- **`diagnose`:** `base-behind`.

## Base refresh

The control plane, not a rework round, brings a candidate outside the queue whose head no longer contains `baseTip` onto it.


The record gains `baseRefresh`:

- `from`: Head the refresh acted on; base it was bound to.
- `base`, `baseTree`: Base-branch tip it was brought onto; that commit's tree.
- `head`: Republished head, or `null` when the merge conflicted.
- `conflict`: Why the merge failed, named for the worker; `null` on success.

Required CI checks never carry anywhere: they run on the republished head, a different tree.

- **Ledger:** `base.refreshed` or `base.conflict` with carry summary, `base.carry` with the full decision.
- **`master run`:** `refresh` action per head and base tip.

## Evidence `scopeFiles`

Evidence may declare the paths its proof depends on:

```json
{ "proof": "unit:queue", "sha": "…", "baseSha": "…", "policyRevision": 1, "result": "pass", "executed": 3, "skipped": 0,
  "scopeFiles": ["src/merge-queue.ts", "src/model/", "tests/"] }
```

## Tree-identical base advances

When the entry ahead merges, the base branch becomes a merge commit whose tree equals the follower's validated tip.

- **Follower:** binds by tree (`binding: "tree-equivalent"` in `master status`), keeps its published tip, candidate, review and evidence bindings, and neither republishes nor moves the pull request branch.
- **Record:** `queue.speculation.carriedBase` (`sha`, `tree`, `at`).
- **Ledger:** `queue.base-carried` event with `tip`, `boundBase`, `baseTree`, `baseTip`.

## Carry across a Graphyard-authored tip

Publishing a tip for an entry not on its predicted base merges that base into the pull request branch; the same rule decides a base refresh, with base branch as predecessor (`predecessor: "base branch"`, always validated) and `baseChanges` taken between the head's bound base and the branch tip. The speculation records `merge`:

- `from`: Replaced head.
- `parents`, `author`, `authoredByApp`: GitHub's account of the tip.
- `conflicts`: Always `false`: the provider merge refuses a conflict with `409`, ejecting the entry.

Binding the tip decides once and records `queue.speculation.carry`:

- `from`, `to`: Replaced head and its bound base; tip and its predicted base.
- `predecessor`: Entry whose tip is the predicted base, or `base branch`.
- `changedFiles`: `merge.baseChanges`. `reviewedFiles`: what the review read, the files the replaced head changed.
- `evidence[]`: Per required proof: `carried`, the `evidenceId` and `producer` it names, the reason.

Nothing carries unless the tip is a two-parent merge of exactly `from.sha` and `to.baseSha`, authored by the control-plane App through the conflict-free merge, over a predecessor whose gates all pass on that tip, with a complete change list. Within that:

- **Approval:** carries when no reviewed file changed.
- **Proof:** carries when its declared scope is disjoint from the change.
- **Every other case:** `carried: false` naming what was touched.
- **Carried binding:** holds only while the candidate is exactly `to` under the same policy revision (and, for agent review, the same reviewer App); revoking the original evidence withdraws it and ejects the tip.
- **Ledger:** one `queue.carry` event per decision, a `carried`/`required` summary on `queue.predicted`.

GitHub dismisses stale reviews on Graphyard's tip push, so before acquiring merge authority `master merge` re-posts a carried approval bound to the tip through the reviewer App that gave it (never the control-plane App, never a human reviewer's approval, never over a reviewer that has since requested changes), reported as `carriedApproval`.

## Where it is reported

- **`GET /api/work-snapshot`:** `queue.speculation.merge`, `.carry`, `.carriedBase`, `baseRefresh`, `observation.baseTip`, `.baseTree`, `.baseTipContained`.
- **`master status`:** each `queue[]` entry's `binding` (`base` with bound sha and tree, `binding`, `carriedTo`; `approval` and `evidence[]` as `exact`, `carried` or `required` with the reason) and each work row's `base` for a pending refresh, conflict or last refresh's carry.
- **`diagnose GY-N`:** `base-behind`, `base-conflict`, `base-refresh-carried`, `base-refresh-required`, `queue-base-carried`, `queue-binding-carried`, `queue-binding-required`.
