<!-- page: Agent protocol | 7 | deferring a proof. -->
# Bootstrap mode for a change that introduces its own proof harness

For an operator shipping a change with its own proof harness: when a proof may be deferred.

The change that creates a proof cannot prove its criterion: the protected harness refuses to run against a base lacking the contract.

- **Declared by:** human operator (`admin`), or an operator agent holding `policy:bootstrap`.
- **Scope:** one criterion in **bootstrap mode**, deferring the proof for this candidate only, never dropping it.

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

The deferred proof becomes an obligation on its contract paths, derived from the work documents, never asserted.

- **Inherited by:** later items whose `plannedFiles` overlap those paths, as a required criterion.
- **Acceptance gate:** `Bootstrap obligation inherited from GY-N AC-M`.
- **No second deferral:** a `bootstrap` declaration over an inherited proof is refused, the inherited requirement evaluated whatever the item declares.

## Inspecting obligations

- **`GET /api/work-snapshot`:** declarations on each criterion.
- **`graphyard obligations`:** every outstanding obligation and who inherits it.
- **`graphyard diagnose GY-N`:** the item's deferrals and inherited obligations.
