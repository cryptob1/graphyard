<!-- page: Agent protocol | 4 | evidence, grants, CI evidence, revocation. -->
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

Trust is decided against the live grant set inside each mutation transaction, never against process configuration. `POST /api/proof-grants/ID/grant` and `/revoke` take `{ "patterns": N }` and require `admin`; optional `expectedRevision` refuses a stale write. [Patterns](../operations-reference.md#proof-authority-grants) parse as an exact name, a whole kind or a bounded prefix, and nothing else. Grants apply only to `producer` principals — `worker`, `reader`, `coordinator` and `operator-agent` are refused with `403` — while `admin` holds the `manual:*` lane by role. Validation collector registrations are bounded by the same live authority, so revoking a grant immediately withdraws a collector's scope; environment allowlists seed the grant store once at startup and decide nothing afterwards. Work creation and every requirement revision record `proofGaps`: required proof names with no authorized producer at that moment, visible in `status`, `diagnose` and the dashboard before dispatch.

## CI-produced evidence

`unit:*` and `integration:*` proofs whose contract is registered in `scripts/contracts.mjs` are also produced without a producer session, by one dedicated **CI producer** — a `producer` whose `runtime` is `github-actions`, granted `unit:*` and `integration:*` and nothing else ([the workflow](../first-pr.md#proofs-in-ci), [provisioning](../deployment.md#ci-producer)). Its records carry a `ciRun` binding — `{ "provider": "github-actions", "repository": "OWNER/REPO", "runId": "RUN", "runAttempt": 1, "jobId": 4242 }` — with `sha`, `baseSha` and `policyRevision` read from the item's candidate record at run time.

- Only the CI producer may submit a `ciRun` binding, and it must submit one: any other principal sending one is refused with `403`, and the CI producer sending none with `400`.
- Only `unit:*` and `integration:*` proofs are accepted from it; `manual:*` and `e2e:*` are refused with `403` whatever it is granted, so a `manual:*` grant to it is inert. The proof must also be covered by its live grant.
- The control plane reads the named job back from GitHub through its own App before the transaction: it must be GitHub Actions' own check run, belong to that workflow run, have run on exactly the evidence `sha`, have completed, and have concluded `success` for a `pass` or otherwise for a `fail`. A mismatch refuses with `403`, a job GitHub cannot report with `503`.
- A record for the same proof, head, base and policy revision is accepted only from a strictly newer run attempt, so re-running or re-publishing an older attempt refuses with `409`.

## Revocation

`POST /api/work/:id/revoke` withdraws accepted evidence with `{proof, sha, baseSha, policyRevision, reason}`. Only an `admin`, or the producer whose live grant covers that exact proof name, may revoke; every other principal is refused, and a request matching no trusted record refuses with 404 rather than withdrawing nothing silently. Revocation withdraws *every* trusted record for that tuple and every record derived from one by reuse, so an older accepted run cannot quietly re-authorize the same candidate or a later head. Records are annotated, never deleted, each keeping a `revocation` object naming the actor, reason and time; the acceptance gate names the withdrawal and reconciliation republishes a refusing check.

## The post-deployment smoke proof

`e2e:deploy-smoke` is the one proof submitted after delivery, and only when the work policy sets `deploySmoke`. Its `sha` is the deployed commit the checks ran against — the one recorded by the `deployment` command — and its `baseSha` is the item's merge commit.

1. The [master loop](../master-agent.md#operate) records the deployment with `POST /api/work/UUID/deployment` once the running release serves the merge commit, exactly or through a descendant. Only a coordinator or operator may record it, only for delivered work, only naming the item's own merge commit, and only once per delivery.
2. The loop asks GitHub to run the trusted smoke workflow with the work UUID, the recorded deployed commit, the merge commit and the policy revision — one request per deployed commit — holding no producer credential.
3. `scripts/deploy-smoke.mjs run` reads the commit the deployment reports serving (`SMOKE_DEPLOYMENT_URL`, field `SMOKE_SHA_FIELD`), refuses unless it is the recorded deployed commit, executes the configured checks (`SMOKE_CHECK_URLS` must answer 2xx; `SMOKE_COMMAND` is optional and comes from the trusted checkout), and reads the serving commit again. A target that moved is a refusal to attribute, not a failure of the delivered change.
4. `scripts/deploy-smoke.mjs publish`, in a separate job holding the producer secret, submits the evidence.

