<!-- page: Agent protocol | 11 | deferring a proof onto the contract a change introduces. -->
# Bootstrap mode for a change that introduces its own proof harness

A change that creates its own proof harness cannot be proven by it. The human operator, or an operator agent holding `policy:bootstrap`, may declare that criterion in bootstrap mode: the proof is deferred for this candidate and never dropped.

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

`reason` is required. `contractPaths` must be unique and lie inside the item's `plannedFiles`. `e2e:` proofs cannot be deferred. `declaredBy`, `declaredAt` and `policyRevision` are stamped by the server. Removing `bootstrap` needs no capability.

## What is owed

The gate stops demanding that criterion's proofs for this candidate only; review, CI and every other criterion still gate it. The proof becomes an obligation on the contract paths: any later item whose `plannedFiles` overlap them inherits it (`Bootstrap obligation inherited from GY-N AC-M`) and cannot defer it again. It is discharged only by a delivery with trusted passing evidence. `graphyard obligations` lists outstanding obligations; `graphyard diagnose GY-N` shows an item's own.
