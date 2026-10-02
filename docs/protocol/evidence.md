<!-- page: Agent protocol | 4 | evidence, grants, revocation. -->
# Evidence and proof authority

`POST /api/work/UUID/evidence`:

```json
{"proof":"integration:claim-safety","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyRevision":1,"result":"pass","executed":32,"skipped":0,"url":"https://github.com/OWNER/REPO/actions/runs/RUN"}
```

The server sets identity, time and trust; ungranted proofs store untrusted; a later failure supersedes a pass.

Trust follows live [grants](../operations-reference.md#proof-authority-grants) (`POST /api/proof-grants/ID/grant`, `/revoke`); `proofGaps` lists required proofs nobody may produce.

The [CI producer](../deployment.md#ci-producer) (`runtime: github-actions`, granted only `unit:*`, `integration:*`) alone sends `{"ciRun":{"provider":"github-actions","repository":"OWNER/REPO","runId":"RUN","runAttempt":1,"jobId":4242}}`, and must. GitHub must confirm the job is the run's, ran on `sha`, concluded `result` (else `403`; unreachable: `503`).

## Revocation

`POST /api/work/:id/revoke` (`admin`, granted producer) with `proof`, `sha`, `baseSha`, `policyRevision`, `reason` withdraws the tuple's trusted records and reuses (annotated, not deleted); delivered work refuses it. Post-delivery `e2e:deploy-smoke` carries `sha` = deployed commit, `baseSha` = merge commit (`delivery.smoke`).
