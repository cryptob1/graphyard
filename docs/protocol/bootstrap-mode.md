<!-- page: Agent protocol | 10 | deferring a proof onto the contract the change introduces, and the obligation it leaves. -->
# Bootstrap mode for a change that introduces its own proof harness

A criterion whose proof does not yet exist cannot be proven by the change that creates it: the
protected harness refuses to run against a base that lacks the contract, so the item stalls. An
operator may declare that one criterion in **bootstrap mode**. The proof is deferred for this
candidate only and is never dropped.

## Bootstrap declaration

```json
{
  "id": "AC-1",
  "text": "Herdr recovery is proven end to end",
  "proofs": ["integration:herdr-recovery"],
  "bootstrap": {
    "reason": "This candidate introduces the herdr-recovery harness the proof needs",
    "contractPaths": ["src/herdr/recovery.ts"]
  }
}
```

`reason` is required and nonblank. `contractPaths` names the contract the deferred proof belongs
to, as exact paths or directory prefixes ending `/`, `/*` or `/**`. Every contract path must lie
inside the item's own `plannedFiles`, so an operator cannot bind an obligation to a contract this
change does not own. Contract paths must be unique.

A criterion whose proofs include an `e2e:` name cannot use bootstrap mode: an E2E proof pins a
scenario revision, environment, and hash on its own work item, and an inherited obligation carries
no pin. Sequence those through the scenario registry instead.

The declaration is accepted on `create` and on `requirements`. It requires the `policy:bootstrap`
capability: an operator-agent holding only `policy:requirements` is refused, and workers cannot
reach either command. `declaredBy`, `declaredAt`, and the declaring `policyRevision` are stamped
from the authenticated actor and the server clock; a client that submits them is rejected. A later
revision that repeats an unchanged declaration keeps the original attribution. Removing `bootstrap`
strengthens the gate and needs no extra capability. Every declaration, with its reason, is in
append-only history.

## What the gate does

The acceptance gate stops demanding the deferred criterion's proofs for
this candidate. Review, the required CI checks, the merge queue, and every other criterion's proofs
still gate it exactly as before. A bootstrap candidate with no review or a failing check does not
advance.

## What is owed

The deferred proof becomes an obligation on its contract paths, derived from the
work documents rather than asserted anywhere. Any later item whose `plannedFiles` overlap those
contract paths inherits the proof as a required criterion, and its acceptance gate reports
`Bootstrap obligation inherited from GY-N AC-M`. The inheriting change cannot defer it again: a
second `bootstrap` declaration over an inherited proof is refused, and the inherited requirement is
evaluated regardless of what that item declares.

An obligation is discharged only when some change is delivered with trusted, passing, complete
evidence for that proof bound to its merged candidate and policy — the same standard as any other
proof. No operator or administrator command retires one.

## Inspecting obligations

`GET /api/work-snapshot` carries the declarations on each criterion. `graphyard obligations` lists
every outstanding obligation and who inherits it, and `graphyard diagnose GY-N` reports the item's
own deferrals and inherited obligations.
