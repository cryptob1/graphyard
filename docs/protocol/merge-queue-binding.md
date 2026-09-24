<!-- page: Agent protocol | 15 | base binding and merge-queue carry. -->
# Merge-queue bindings and carry

A review and every proof bind one head, base and policy revision. Mechanism: [GitHub enforcement](../github.md#merge-queue).

## The observed base

`observation.baseTip` is the branch head; `observation.baseTipContained` says whether the head contains it; `candidate.baseSha` is the bound base (a speculative tip's predicted base, else the previously bound base while contained, else `baseTip`). While the head does not contain the tip, reviews wait (`base-behind`).

## Base refresh

A candidate outside the queue that fell behind is merged onto the tip by the control plane, recording `baseRefresh` and `base.refreshed`. A conflict (`base.conflict`) returns the item to `build` and invalidates its bindings.

## Carry across a Graphyard-authored tip

Evidence may declare `scopeFiles` (`plannedFiles` syntax, 1–100 entries); only such records can carry. A binding carries onto the App's conflict-free merge of the old head and the predicted base when the change list is complete: the approval if no reviewed file changed, each proof if its scope is disjoint from the change. The decision is `queue.speculation.carry` and a `queue.carry` event; a tree-identical base advance records `queue.base-carried`. Revoking the original evidence withdraws the carry.

## Where it is reported

- `GET /api/work-snapshot`: `queue.speculation.merge`, `.carry`, `.carriedBase`; `baseRefresh`; `observation.baseTip`, `.baseTree`, `.baseTipContained`.
- `master status`: each queue entry's `binding` (`exact`, `carried`, `required`).
- `diagnose GY-N`: `base-behind`, `base-conflict`, `base-refresh-carried`, `base-refresh-required`, `queue-base-carried`, `queue-binding-carried`, `queue-binding-required`.
