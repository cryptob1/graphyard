<!-- page: Agent protocol | 5 | evidence, grants, revocation. -->
# Evidence and proof authority

For a producer or integration author: what makes an evidence record trusted.

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

## Proof authority

Trust is decided against the live grant set inside each mutation transaction, never process configuration. `POST /api/proof-grants/ID/grant` and `/revoke` take `{ "patterns": N }` and require `admin`; optional `expectedRevision` refuses a stale write, and [patterns](../operations-reference.md#proof-authority-grants) parse as an exact name, a whole kind or a bounded prefix, nothing else. Grants apply only to `producer` principals — `worker`, `reader`, `coordinator` and `operator-agent` refuse with `403` — while `admin` holds the `manual:*` lane by role. Collector registrations are bounded by the same live authority, so revoking a grant withdraws a collector's scope at once; environment allowlists seed the grant store at startup and decide nothing afterwards. Work creation and every requirement revision record `proofGaps`: required proof names with no authorized producer, visible in `status`, `diagnose` and the dashboard before dispatch.

## CI-produced evidence

`unit:*` and `integration:*` proofs whose contract is registered in `scripts/contracts.mjs` are also produced without a producer session, by one dedicated **CI producer** — a `producer` whose `runtime` is `github-actions`, granted `unit:*` and `integration:*` and nothing else ([the workflow](../github.md#proofs-in-ci), [provisioning](../deployment.md#ci-producer)). Its records carry a `ciRun` binding — `{ "provider": "github-actions", "repository": "OWNER/REPO", "runId": "RUN", "runAttempt": 1, "jobId": 4242 }` — with `sha`, `baseSha` and `policyRevision` from the item's candidate record.

- Only the CI producer may submit a `ciRun` binding, and it must: any other principal sending one refuses with `403`, the CI producer sending none with `400`.
- Only `unit:*` and `integration:*` proofs are accepted from it, and only within its live grant; `manual:*` and `e2e:*` refuse with `403` whatever it is granted.
- The control plane reads the named job back from GitHub through its own App before the transaction: it must be GitHub Actions' own check run, belong to that workflow run, have run on exactly the evidence `sha`, have completed, and have concluded `success` for a `pass` or otherwise for a `fail`. A mismatch refuses with `403`, a job GitHub cannot report with `503`.
- A record for the same proof, head, base and policy revision is accepted only from a strictly newer run attempt; re-publishing an older attempt refuses with `409`.

## Revocation

`POST /api/work/:id/revoke` withdraws accepted evidence with `{proof, sha, baseSha, policyRevision, reason}`. Only an `admin`, or the producer whose live grant covers that exact proof name, may revoke; anyone else is refused, and a request matching no trusted record refuses with 404. Revocation withdraws *every* trusted record for that tuple and every record derived from one by reuse, so an older accepted run cannot re-authorize the same candidate or a later head. Records are annotated, never deleted, each keeping a `revocation` object naming actor, reason and time; the acceptance gate names the withdrawal and reconciliation republishes a refusing check.

## The post-deployment smoke proof

`e2e:deploy-smoke` is the one proof submitted after delivery, and only when the work policy sets `deploySmoke`: its `sha` is the deployed commit the checks ran against, recorded by the `deployment` command, and its `baseSha` the item's merge commit.

1. The [master loop](../master-agent.md#operate) records the deployment with `POST /api/work/UUID/deployment` once the running release serves the merge commit, exactly or through a descendant: coordinator or operator only, delivered work only, naming the item's own merge commit, once per delivery.
2. The loop asks GitHub to run the trusted smoke workflow with the work UUID, the deployed commit, the merge commit and the policy revision — one request per deployed commit — holding no producer credential.
3. `scripts/deploy-smoke.mjs run` reads the commit the deployment reports serving (`SMOKE_DEPLOYMENT_URL`, field `SMOKE_SHA_FIELD`), refuses unless it is the recorded deployed commit, runs the configured checks (`SMOKE_CHECK_URLS` must answer 2xx; the optional `SMOKE_COMMAND` comes from the trusted checkout), and reads the serving commit again; a target that moved is a refusal to attribute, not a failure of the change.
4. `scripts/deploy-smoke.mjs publish`, in a separate job holding the producer secret, submits the evidence.

