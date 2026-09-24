<!-- page: Agent protocol | 9 | evidence submission, proof authority grants, and the post-deployment smoke proof. -->
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

SHAs are full 40-character lowercase. `result` is `pass` or `fail`; counts are nonnegative integers (for manual acceptance, the criteria inspected). The server supplies ID, identity, time and trust; clients cannot set `trusted` or `producer`, and unknown fields are rejected. An unauthorized proof is stored untrusted.

All required proofs must pass for the exact head/base/policy tuple. A later matching failure supersedes a pass; stale evidence is kept for audit. A record with a `reuse` block was derived by a [reuse decision](../evidence-reuse.md#reuse-decisions); any newer live attempt supersedes it.

## Proof authority

Trust is decided against the live grant set inside each transaction. `POST /api/proof-grants/ID/grant` and `/revoke` take `{ "patterns": [...], "reason": "...", "expectedRevision": N }` (`admin`). A pattern is an exact name, a kind (`integration:*`) or a bounded prefix (`manual:gy-43/*`). Grants apply only to `producer` principals; `admin` holds `manual:*` by role. Environment allowlists only seed the store at startup. Work creation and requirement revisions record `proofGaps`: required proofs no producer may currently satisfy.

### CI-produced evidence

`unit:*` and `integration:*` proofs registered in `scripts/contracts.mjs` are run by the protected acceptance workflow on each candidate push and published by one **CI producer** (a `producer` with `runtime: github-actions`, granted `unit:*` and `integration:*` only; see [GitHub](../github.md#trusted-test-producers) and [deployment](../deployment.md#ci-producer)). Its records add:

```json
{ "ciRun": { "provider": "github-actions", "repository": "OWNER/REPO", "runId": "RUN", "runAttempt": 1, "jobId": 4242 } }
```

- Only the CI producer may send `ciRun`, and it must (`403` / `400` otherwise); it may not submit `manual:*` or `e2e:*`.
- The server reads the job back through its App: it must be GitHub Actions' check run for `runId`, on exactly `sha`, completed with a conclusion matching `result` (`403` on mismatch, `503` if GitHub cannot answer).
- For the same tuple only a strictly newer run attempt is accepted (`409` otherwise).

The reporter `scripts/publish-acceptance.mjs` accepts only `pull_request_target` and `workflow_dispatch` runs.

### Revocation

`POST /api/work/:id/revoke` (`admin`, or the producer whose grant covers the proof):

```json
{ "proof": "integration:claim-safety", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "baseSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "policyRevision": 1, "reason": "Reported run was attributed to the wrong artifact" }
```

It withdraws every trusted record for the tuple and everything reused from them (annotated, never deleted), or returns 404 when nothing matches. The gate names the withdrawal and the merge queue ejects the entry. A revocation that meets a merge already committed to the provider is refused until the outcome is observed ([merge broker](../github.md#enforcement-boundary)). Delivered work refuses revocation.

`e2e:deploy-smoke` is submitted after delivery: `sha` is the deployed commit recorded by `deployment`, `baseSha` the merge commit; accepted only from a granted producer when the policy sets `deploySmoke`. It is recorded as `delivery.smoke`.
