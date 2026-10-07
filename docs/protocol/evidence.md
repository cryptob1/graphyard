<!-- page: Agent protocol | 4 | evidence, grants. -->
# Evidence and grants

`POST /api/work/UUID/evidence`:

```json
{"proof":"integration:claim-safety","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyRevision":1,"result":"pass","executed":32,"skipped":0,"url":"https://github.com/OWNER/REPO/actions/runs/RUN"}
```

The server sets identity, time and trust; ungranted proofs store untrusted, and later failures supersede passes. Trust follows live [grants](../operations-reference.md#proof-authority-grants) (`POST /api/proof-grants/ID/grant`, `/revoke`); `proofGaps` lists required proofs nobody may produce. The [CI producer](../deployment.md#ci-producer) (`runtime: github-actions`, granted only `unit:*`, `integration:*`) always sends `{"ciRun":{"provider":"github-actions", "repository":"OWNER/REPO", "runId":"RUN", "runAttempt":1, "jobId":4242}}`, and the server reads the job back from GitHub: same run, exactly `sha`, concluded `result` (else `403`; unreachable: `503`).

## Revocation

`POST /api/work/:id/revoke` (`admin`, granted producer) with `proof`, `sha`, `baseSha`, `policyRevision`, `reason` withdraws that tuple's trusted records; delivered work refuses. Post-delivery `e2e:deploy-smoke` uses the deployed and merge commits (`delivery.smoke`).
