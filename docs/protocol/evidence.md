<!-- page: Agent protocol | 4 | evidence, grants, revocation. -->
# Evidence and proof authority

`POST /api/work/UUID/evidence`:

```json
{"proof":"integration:claim-safety","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
 "policyRevision":1,"result":"pass","executed":32,"skipped":0,"url":"https://github.com/OWNER/REPO/actions/runs/RUN"}
```

The server sets identity, time and trust; an ungranted proof is stored untrusted; a later failure supersedes a pass.

## Proof authority

Trust is judged against live [grants](../operations-reference.md#proof-authority-grants) (`POST /api/proof-grants/ID/grant` and `/revoke`); `proofGaps` lists required proofs nobody may currently produce.

The CI producer (`runtime: github-actions`, granted only `unit:*` and `integration:*`; see [deployment](../deployment.md#ci-producer)) must send, and only it may send, `{"ciRun":{"provider":"github-actions", "repository":"OWNER/REPO", "runId":"RUN", "runAttempt":1, "jobId":4242}}`. The server reads the job back: it must belong to the run, have run on exactly `sha` and concluded as `result` (`403` otherwise, `503` if GitHub cannot answer).

## Revocation

`POST /api/work/:id/revoke` (`admin`, or the granted producer) with `proof`, `sha`, `baseSha`, `policyRevision` and `reason` withdraws every trusted record for the tuple and anything reused from it (annotated, never deleted). Delivered work refuses revocation. `e2e:deploy-smoke` is submitted after delivery with `sha` the deployed commit and `baseSha` the merge commit, recorded as `delivery.smoke`.
