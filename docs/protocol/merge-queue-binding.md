<!-- page: Agent protocol | 8 | base binding and carry. -->
# Merge-queue bindings and carry

For an integration author: what a candidate is bound to.

## The observed base

Every observation reads the managed branch from `refs/heads/<base>` and records:

- `observation.baseTip`: The branch head sha. Never the pull request's cached `base.sha`.
- `observation.baseTree`: That commit's tree.
- `observation.baseTipContained`: The head contains `baseTip`: by ancestry, or as a published queue tip whose bound base is tree-identical to it or which sits behind other queue entries.
- `candidate.baseSha`: The bound base: the predicted base of a published speculative tip for this head under this policy revision; otherwise the base the head was already bound to while it is behind `baseTip` and the branch still contains that commit ([base refresh](#base-refresh)); otherwise `baseTip`.

A review is requested only while `baseTipContained` is not `false`: `master review` refuses with `does not contain the base branch tip`, the `codex` and `agent` dispatchers defer, and `diagnose` reports `base-behind`. That is a wait of seconds: the control plane republishes the head itself and the request goes to what it publishes.

## Base refresh

A candidate outside the queue whose head no longer contains `baseTip` is brought onto it by the control plane, not by a rework round: the reconciliation job merges the base branch into the pull-request branch with the same conflict-free provider merge (Contents: write, no ref of its own), once per head, base tip and policy revision, leaving a queued entry to its own speculative tip. While that is pending the bound base is held, so bindings made on the unchanged tree stand; the hold ends when the head contains the tip, when a rewound branch no longer contains the held commit, or on a conflict. The record gains `baseRefresh`:

- `from`: The head the refresh acted on and the base it was bound to.
- `base`, `baseTree`: The base-branch tip it was brought onto, and that commit's tree.
- `head`: The republished head, or `null` when the merge conflicted.
- `conflict`: Why the base could not be merged in, named for the worker; `null` on success.
- `merge`: GitHub's account of the commit, as `queue.speculation.merge` below. `carry`: the carry decision, by the rule below, with the base branch as the predecessor.

Required CI checks never carry, here or anywhere: the republished head is a different tree, so they run on it. The ledger records `base.refreshed` or `base.conflict` with the carry summary and `base.carry` with the full decision, and `master run` records a `refresh` action per head and base tip. A conflict writes nothing — no commit, no ref, no carried binding: the build gate names it, the item returns to `build`, and the released hold invalidates the approval and every proof, because resolving a conflict is content nobody reviewed.

## Evidence `scopeFiles`

An evidence submission may declare the paths the proof depends on:

```json
{ "proof": "unit:queue", "sha": "…", "baseSha": "…", "policyRevision": 1, "result": "pass", "executed": 3, "skipped": 0,
  "scopeFiles": ["src/merge-queue.ts", "src/model/", "tests/"] }
```

## Tree-identical base advances

When the entry ahead merges, the base branch becomes a merge commit whose tree equals the tip the follower was validated on. The follower binds by tree (`binding: "tree-equivalent"` in `master status`), keeps its published tip, candidate, review and evidence bindings, and neither republishes nor moves the pull request branch. The record gains `queue.speculation.carriedBase` (`sha`, `tree`, `at`) and the ledger a `queue.base-carried` event with `tip`, `boundBase`, `baseTree` and `baseTip`.

## Carry across a Graphyard-authored tip

Publishing a tip for an entry not already on its predicted base merges that base into the pull request branch; the same rule decides a base refresh, with the base branch as the predecessor (`predecessor: "base branch"`, always validated) and `baseChanges` taken between the head's bound base and the branch tip. The speculation records `merge`: the replaced head (`from`), GitHub's account of the tip's `parents` and `author`, `authoredByApp`, `conflicts` (always `false` for the provider merge, which refuses a conflict with `409` and ejects the entry) and `baseChanges`, the paths changed between the replaced head's bound base and the predicted base — `null` when GitHub could not list them completely, since the compare API reports first-page files only and stops at 300. Binding the tip decides once and records `queue.speculation.carry`:

- `from`, `to`: The replaced head and its bound base; the tip and its predicted base.
- `predecessor`: The entry whose tip is the predicted base, or `base branch`.
- `changedFiles`: `merge.baseChanges`. `reviewedFiles`: what the review read, the files the replaced head changed.
- `approval`: `carried: true` with `provider`, `reviewer`, `reviewId`, `reviewerApp`, `originalSha` and the reason, or `carried: false` with the reason.
- `evidence[]`: Per required proof: `carried`, the `evidenceId` and `producer` it names, and the reason.

Nothing carries unless the tip is a two-parent merge of exactly `from.sha` and `to.baseSha`, authored by the control-plane App through the conflict-free merge, over a predecessor whose own gates all pass on that tip, with a complete change list; within that the approval carries when no reviewed file changed and a proof when its declared scope is disjoint from the change. Every other case is `carried: false` naming what was touched. A carried record is named by its `evidenceId`, so one carried twice stays the record the latest decision names, and a carried binding holds only while the candidate is exactly `to` under the same policy revision (and, for agent review, the same reviewer App); revoking the original evidence withdraws it and ejects the tip. The ledger holds one `queue.carry` event per decision and a `carried`/`required` summary on `queue.predicted`.

GitHub dismisses stale reviews on Graphyard's own tip push, so before acquiring merge authority `master merge` re-posts a carried approval bound to the tip through the reviewer App that gave it — never the control-plane App, never a human reviewer's approval, never over a reviewer that has since requested changes — reporting it as `carriedApproval`.

## Where it is reported

`GET /api/work-snapshot` documents `queue.speculation.merge`, `.carry` and `.carriedBase`, `baseRefresh`, and `observation.baseTip`, `.baseTree` and `.baseTipContained`. `master status` reports each `queue[]` entry's `binding` — `base` (bound sha and tree, `binding`, `carriedTo`), `approval` and `evidence[]` as `exact`, `carried` or `required` with the reason — and each work row's `base` for a pending refresh, a conflict or the last refresh's carry. `diagnose GY-N` reports `base-behind`, `base-conflict`, `base-refresh-carried`, `base-refresh-required`, `queue-base-carried`, `queue-binding-carried` and `queue-binding-required`.
