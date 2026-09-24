<!-- page: Agent protocol | 9 | evidence, proof grants, revocation, smoke proof. -->
# Evidence and proof authority

```json
{
  "proof": "integration:claim-safety",
  "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "baseSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "policyRevision": 1,
  "result": "pass",
  "executed": 32,
  "skipped": 0,
  "url": "https://github.com/OWNER/REPO/actions/runs/RUN"
}
```

SHAs are full lowercase 40-character; `result` is `pass` or `fail`. The server sets identity, time and trust; unknown fields are rejected and an ungranted proof is stored untrusted. Every required proof must pass for the exact head/base/policy tuple; a later failure supersedes a pass. A `reuse` block marks a record derived by a [reuse decision](../evidence-reuse.md#reuse-decisions).

## Proof authority

Trust is judged against live grants in each transaction. `POST /api/proof-grants/ID/grant` and `/revoke` (`admin`) take `{ "patterns": [...], "reason": "...", "expectedRevision": N }`; a pattern is an exact name, a kind (`integration:*`) or a prefix (`manual:gy-43/*`). Only `producer` principals receive grants; `admin` holds `manual:*` by role. `proofGaps` on an item lists required proofs nobody may currently produce.

### CI-produced evidence

Registered `unit:*` and `integration:*` contracts run in the protected acceptance workflow and are published by one **CI producer** (`runtime: github-actions`, granted only those kinds; see [GitHub](../github.md#trusted-test-producers) and [deployment](../deployment.md#ci-producer)) with a run binding:

```json
{ "ciRun": { "provider": "github-actions", "repository": "OWNER/REPO", "runId": "RUN", "runAttempt": 1, "jobId": 4242 } }
```

Only the CI producer may send `ciRun`, and it must. The server reads the job back from GitHub: it must belong to the run, have run on exactly `sha` and concluded to match `result` (`403` otherwise, `503` if GitHub cannot answer). Only a newer run attempt replaces a record (`409` otherwise).

### Revocation

`POST /api/work/:id/revoke` (`admin`, or the granted producer):

```json
{ "proof": "integration:claim-safety", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "baseSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "policyRevision": 1, "reason": "Reported run was attributed to the wrong artifact" }
```

It withdraws every trusted record for the tuple and anything reused from them (annotated, never deleted), or returns 404. The merge queue ejects the entry; a merge already committed to the provider refuses revocation until observed ([merge broker](../github.md#enforcement-boundary)). Delivered work refuses revocation.

`e2e:deploy-smoke` is submitted after delivery with `sha` the deployed commit and `baseSha` the merge commit, only when the policy sets `deploySmoke`; it is recorded as `delivery.smoke`.
