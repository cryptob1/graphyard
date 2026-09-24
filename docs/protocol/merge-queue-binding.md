<!-- page: Agent protocol | 15 | how a candidate is bound to its base, when the merge queue carries a review or proof across a Graphyard-authored tip, and what the record and ledger say about it. -->
# Merge-queue bindings and carry

A review and every trusted proof bind one head sha, base sha and policy revision. The mechanism is in [GitHub enforcement](../github.md#merge-queue).

## The observed base

| Field | Meaning |
| --- | --- |
| `observation.baseTip` | The branch head sha (never the PR's cached `base.sha`) |
| `observation.baseTipContained` | The head contains `baseTip`, by ancestry or as a published queue tip |
| `candidate.baseSha` | The bound base: a speculative tip's predicted base, else the previously bound base while still contained, else `baseTip` |

While `baseTipContained` is `false`, reviews wait (`diagnose` reports `base-behind`) and the control plane republishes the head on the new tip.

## Base refresh

A candidate outside the queue whose head no longer contains `baseTip` is merged onto it by the control plane, once per head, base tip and policy revision, recording `baseRefresh` (`from`, `base`, `head`, `conflict`, `carry`) and `base.refreshed` or `base.conflict`. A conflict writes nothing: the item returns to `build` and bindings are invalidated.

## Evidence `scopeFiles`

Evidence may declare the paths it depends on (`plannedFiles` syntax, 1–100 entries), e.g. `"scopeFiles": ["src/merge-queue.ts", "tests/"]`. Only a record with declared scope can be carried.

## Carry across a Graphyard-authored tip

A binding carries onto a new tip only when the tip is the App's conflict-free two-parent merge of the old head and the predicted base, the predecessor's gates pass on it, and the change list is complete (under GitHub's 300-file cap). The approval carries when no reviewed file changed; each proof carries when its scope is disjoint from the change. The decision is recorded as `queue.speculation.carry` (`approval`, `evidence[]`, each with `carried` and a reason) and a `queue.carry` event. A tree-identical base advance keeps the tip and records `queue.base-carried`. Revoking the original evidence withdraws the carry. `master merge` re-posts a carried GitHub approval through the reviewer App that gave it.

## Where it is reported

- `GET /api/work-snapshot`: `queue.speculation.merge`, `.carry`, `.carriedBase`; `baseRefresh`; `observation.baseTip`, `.baseTree`, `.baseTipContained`.
- `master status`: each queue entry's `binding` (`exact`, `carried` or `required`) and each row's `base`.
- `diagnose GY-N`: `base-behind`, `base-conflict`, `base-refresh-carried`, `base-refresh-required`, `queue-base-carried`, `queue-binding-carried`, `queue-binding-required`.
