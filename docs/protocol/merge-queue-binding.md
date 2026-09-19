<!-- page: Agent protocol | 15 | how a candidate is bound to its base, when the merge queue carries a review or proof across a Graphyard-authored tip, and what the record and ledger say about it. -->
# Merge-queue bindings and carry

A review and every trusted proof bind one exact candidate: head sha, base sha and policy revision. This page states what the base is, and the one case in which Graphyard carries a binding from one commit to another. The mechanism is described in [GitHub enforcement](../github.md#merge-queue); this is the record-level contract.

## The observed base

Every observation reads the managed branch from `refs/heads/<base>` and records:

| Field | Meaning |
| --- | --- |
| `observation.baseTip` | The branch head sha. Never the pull request's cached `base.sha`. |
| `observation.baseTree` | That commit's tree. |
| `observation.baseTipContained` | The head contains `baseTip`: by ancestry, or as a published queue tip whose bound base is tree-identical to it or which sits behind other queue entries. |
| `candidate.baseSha` | The bound base: the predicted base of a published speculative tip for this head under this policy revision, otherwise `baseTip`. |

A review is requested only while `baseTipContained` is not `false`: `master review` refuses with `does not contain the base branch tip`, the Codex and agent dispatchers defer, and `diagnose` reports `base-behind`. The worker runs `graphyard sync GY-N` and pushes, or the queue publishes a tip that contains the base once the candidate is proven.

## Evidence `scopeFiles`

An evidence submission may declare the paths the proof depends on:

```json
{ "proof": "unit:queue", "sha": "…", "baseSha": "…", "policyRevision": 1, "result": "pass", "executed": 3, "skipped": 0,
  "scopeFiles": ["src/merge-queue.ts", "src/model/", "tests/"] }
```

The syntax is that of `plannedFiles`: exact paths, or directory prefixes ending in `/`, `/*` or `/**`; one to a hundred entries. The declaration changes nothing about trust or applicability on the commit it names. It is what lets the merge queue carry the record onto a Graphyard-authored tip: a record with no declared scope is never carried.

## Tree-identical base advances

When the queue entry ahead merges, the base branch becomes a merge commit whose tree equals the tip the follower was validated on. The follower's placement binds by tree (`binding: "tree-equivalent"` in `master status`), keeps its published tip, candidate, review and evidence bindings, and does not republish or move the pull request branch. The record gains `queue.speculation.carriedBase` (`sha`, `tree`, `at`) and the ledger a `queue.base-carried` event with `tip`, `boundBase`, `baseTree` and `baseTip`. An advance that changes the tree is stale: the head republishes and the entries behind it are re-based.

## Carry across a Graphyard-authored tip

Publishing a tip for an entry not already on its predicted base merges that base into the pull request branch. The speculation records `merge`: the replaced head (`from`), GitHub's account of the tip's `parents` and `author`, `authoredByApp`, `conflicts` (always `false` for the provider merge, which refuses a conflict with `409` and ejects the entry) and `baseChanges`, the paths changed between the replaced head's bound base and the predicted base (`null` when GitHub could not list them within the budget). When Graphyard binds the tip it decides once and records `queue.speculation.carry`:

| Field | Meaning |
| --- | --- |
| `from`, `to` | The replaced head and its bound base; the tip and its predicted base. |
| `predecessor` | The entry whose tip is the predicted base, or `base branch`. |
| `changedFiles` | `merge.baseChanges`. |
| `reviewedFiles` | The files the replaced head changed: what the review read. |
| `approval` | `carried: true` with `provider`, `reviewer`, `reviewId`, `reviewerApp`, `originalSha` and the reason, or `carried: false` with the reason. |
| `evidence[]` | Per required proof: `carried`, the `evidenceId` and `producer` it names, and the reason. |

Nothing carries unless the tip is a two-parent merge of exactly `from.sha` and `to.baseSha`, authored by the control-plane App, produced by Graphyard's conflict-free merge, over a predecessor whose own gates all pass on that tip, with a complete change list. Within that, the approval carries when the predecessor changed no reviewed file, and each proof carries when its declared scope is disjoint from the change (or the change is empty). Every other case is `carried: false` with the reason that names what was touched.

A carried binding is a standing judgement over the original record: it applies only while the candidate is exactly `to` under the same policy revision (and, for agent review, while the policy still dispatches to the same reviewer App). Revoking the original evidence withdraws the carried binding and ejects the tip. The ledger holds one `queue.carry` event per decision and a `carried`/`required` summary on `queue.predicted`.

GitHub dismisses stale reviews on Graphyard's own tip push. Before acquiring merge authority, `master merge` re-posts a carried GitHub approval bound to the tip through the reviewer App that gave it — never through the control-plane App, never for a human approval, and never over a reviewer that has since requested changes — and reports the outcome as `carriedApproval` in its result.

## Where it is reported

- `GET /api/work-snapshot` documents: `queue.speculation.merge`, `.carry`, `.carriedBase`; `observation.baseTip`, `.baseTree`, `.baseTipContained`.
- `master status`: each `queue[]` entry's `binding` — `base` (bound sha and tree, `binding`, `carriedTo`), `approval` and `evidence[]` as `exact`, `carried` or `required` with the reason.
- `diagnose GY-N`: `base-behind`, `queue-base-carried`, `queue-binding-carried`, `queue-binding-required`.
