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

Trust is decided against the live grant set inside each mutation transaction, never process configuration.

- **`POST /api/proof-grants/ID/grant` and `/revoke`:** take `{ "patterns": N }`, require `admin`; optional `expectedRevision` refuses a stale write.
- **[Patterns](../operations-reference.md#proof-authority-grants):** an exact name, a whole kind or a bounded prefix, nothing else.
- **Grantees:** `producer` principals only: `worker`, `reader`, `coordinator` and `operator-agent` refuse with `403`; `admin` holds the `manual:*` lane by role.
- **Collector registrations:** bounded by the same live authority; revoking a grant withdraws a collector's scope at once.
- **Environment allowlists:** seed the grant store at startup and decide nothing afterwards.
- **`proofGaps`:** required proof names with no authorized producer, recorded at work creation and every requirement revision, visible in `status`, `diagnose` and the dashboard before dispatch.

## CI-produced evidence

One dedicated **CI producer** ([the workflow](../github.md#proofs-in-ci), [provisioning](../deployment.md#ci-producer)) also produces, without a producer session, `unit:*` and `integration:*` proofs whose contract is registered in `scripts/contracts.mjs`.

- **Principal:** a `producer` whose `runtime` is `github-actions`.
- **Grant:** `unit:*` and `integration:*` and nothing else.
- **`ciRun` binding:** `{ "provider": "github-actions", "repository": "OWNER/REPO", "runId": "RUN", "runAttempt": 1, "jobId": 4242 }` on each record, with `sha`, `baseSha` and `policyRevision` from the item's candidate record.
- Only the CI producer may, and must, submit a `ciRun` binding: another principal sending one refuses with `403`, the CI producer sending none with `400`.
- Accepted from it: only `unit:*` and `integration:*` proofs within its live grant; `manual:*` and `e2e:*` refuse with `403` whatever it is granted.
- Before the transaction the control plane reads the named job back from GitHub through its own App: it must be GitHub Actions' own check run, belong to that workflow run, have run on exactly the evidence `sha`, and have completed with `success` for a `pass`, anything else for a `fail`. A mismatch refuses with `403`, a job GitHub cannot report with `503`.
- A record for the same proof, head, base and policy revision is accepted only from a strictly newer run attempt; an older one refuses with `409`.

## Revocation

`POST /api/work/:id/revoke` withdraws accepted evidence with `{proof, sha, baseSha, policyRevision, reason}`.

- **Who:** an `admin`, or the producer whose live grant covers that exact proof name; others are refused.
- **No matching trusted record:** refuses with 404.
- **Scope:** *every* trusted record for that tuple and every record reuse derived from one, so an older accepted run cannot re-authorize the same candidate or a later head.
- **Records:** annotated, never deleted, each keeping a `revocation` object naming actor, reason and time.
- **Gate:** the acceptance gate names the withdrawal; reconciliation republishes a refusing check.

## The post-deployment smoke proof

`e2e:deploy-smoke` is the one proof submitted after delivery, only under a work policy setting `deploySmoke`.

- **`sha`:** the deployed commit the checks ran against, recorded by the `deployment` command.
- **`baseSha`:** the item's merge commit.

1. The [master loop](../master-agent.md#operate) records the deployment with `POST /api/work/UUID/deployment` ([who and when](work-commands.md#commands)) once the running release serves the merge commit, exactly or through a descendant.
2. The loop, holding no producer credential, asks GitHub to run the trusted smoke workflow with the work UUID, deployed commit, merge commit and policy revision, one request per deployed commit.
3. `scripts/deploy-smoke.mjs run` reads the commit the deployment reports serving (`SMOKE_DEPLOYMENT_URL`, field `SMOKE_SHA_FIELD`), refuses unless it is the recorded deployed commit, runs the configured checks (`SMOKE_CHECK_URLS` must answer 2xx; the optional `SMOKE_COMMAND` comes from the trusted checkout), and reads the serving commit again; a moved target is a refusal to attribute, not a failure of the change.
4. `scripts/deploy-smoke.mjs publish`, in a separate job holding the producer secret, submits the evidence.

