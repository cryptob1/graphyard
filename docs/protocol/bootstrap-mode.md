<!-- page: Agent protocol | 7 | deferring a proof. -->
# Bootstrap mode for a change that introduces its own proof harness

For an operator shipping a change with its own proof harness.

A criterion whose proof does not exist yet cannot be proven by the change that creates it: the protected harness refuses to run against a base lacking the contract. The human operator (`admin`), or an operator agent holding `policy:bootstrap`, may declare that one criterion in **bootstrap mode**, deferring the proof for this candidate only, never dropping it.

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

## What the gate does

The acceptance gate stops demanding the deferred criterion's proofs for this candidate.

## What is owed

The deferred proof becomes an obligation on its contract paths, derived from the work documents rather than asserted. Any later item whose `plannedFiles` overlap those paths inherits it as a required criterion, its acceptance gate reporting `Bootstrap obligation inherited from GY-N AC-M`, and cannot defer it again: a second `bootstrap` declaration over an inherited proof is refused, and the inherited requirement is evaluated whatever the item declares.

## Inspecting obligations

`GET /api/work-snapshot` carries the declarations on each criterion; `graphyard obligations` lists every outstanding obligation and who inherits it, and `graphyard diagnose GY-N` reports the item's own deferrals and inherited obligations.
