<!-- page: Agent protocol | 15 | base binding and carry. -->
# Merge-queue bindings and carry

For an integration author: what a candidate is bound to.

## The observed base

Every observation reads the managed branch from `refs/heads/<base>` and records:

- `observation.baseTip`: The branch head sha. Never the pull request's cached `base.sha`.
- `observation.baseTree`: That commit's tree.
- `observation.baseTipContained`: The head contains `baseTip`: by ancestry, or as a published queue tip whose bound base is tree-identical to it or which sits behind other queue entries.
- `candidate.baseSha`: The bound base: the predicted base of a published speculative tip for this head under this policy revision, otherwise `baseTip`.

## Evidence `scopeFiles`

An evidence submission may declare the paths the proof depends on:

```json
{ "proof": "unit:queue", "sha": "…", "baseSha": "…", "policyRevision": 1, "result": "pass", "executed": 3, "skipped": 0,
  "scopeFiles": ["src/merge-queue.ts", "src/model/", "tests/"] }
```

## Tree-identical base advances

When the queue entry ahead merges, the base branch becomes a merge commit whose tree equals the tip the follower was validated on. The follower's placement binds by tree (`binding: "tree-equivalent"` in `master status`), keeps its published tip, candidate, review and evidence bindings, and does not republish or move the pull request branch. The record gains `queue.speculation.carriedBase` (`sha`, `tree`, `at`) and the ledger a `queue.base-carried` event with `tip`, `boundBase`, `baseTree` and `baseTip`.

## Carry across a Graphyard-authored tip

Publishing a tip for an entry not already on its predicted base merges that base into the pull request branch. The speculation records `merge`: the replaced head (`from`), GitHub's account of the tip's `parents` and `author`, `authoredByApp`, `conflicts` (always `false` for the provider merge, which refuses a conflict with `409` and ejects the entry) and `baseChanges`, the paths changed between the replaced head's bound base and the predicted base (`null` when GitHub could not list them completely: the compare API reports first-page files only and stops at 300, so a list reaching that cap is treated as truncated). When Graphyard binds the tip it decides once and records `queue.speculation.carry`:

- `from`, `to`: The replaced head and its bound base; the tip and its predicted base.
- `predecessor`: The entry whose tip is the predicted base, or `base branch`.
- `changedFiles`: `merge.baseChanges`.
- `reviewedFiles`: The files the replaced head changed: what the review read.
- `approval`: `carried: true` with `provider`, `reviewer`, `reviewId`, `reviewerApp`, `originalSha` and the reason, or `carried: false` with the reason.
- `evidence[]`: Per required proof: `carried`, the `evidenceId` and `producer` it names, and the reason.

## Where it is reported

- `GET /api/work-snapshot` documents: `queue.speculation.merge`, `.carry`, `.carriedBase`; `observation.baseTip`, `.baseTree`, `.baseTipContained`.
- `master status`: each `queue[]` entry's `binding` — `base` (bound sha and tree, `binding`, `carriedTo`), `approval` and `evidence[]` as `exact`, `carried` or `required` with the reason.
- `diagnose GY-N`: `base-behind`, `queue-base-carried`, `queue-binding-carried`, `queue-binding-required`.
