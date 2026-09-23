<!-- page: Agent protocol | 5 | evidence, grants. -->
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
- **Environment allowlists:** seed the grant store at startup and decide nothing afterwards.

## CI-produced evidence

One dedicated **CI producer** ([the workflow](../github.md#proofs-in-ci), [provisioning](../deployment.md#ci-producer)) also produces, without a producer session, `unit:*` and `integration:*` proofs whose contract is registered in `scripts/contracts.mjs`.

- **Principal:** a `producer` whose `runtime` is `github-actions`.
- **Grant:** `unit:*` and `integration:*` and nothing else.

## Revocation

`POST /api/work/:id/revoke` withdraws accepted evidence with `{proof, sha, baseSha, policyRevision, reason}`.

- **Who:** an `admin`, or the producer whose live grant covers that exact proof name; others refuse.
- **No matching trusted record:** refuses with 404.
- **Scope:** *every* trusted record for that tuple and every record reuse derived from one, so no older accepted run re-authorizes the candidate or a later head.
- **Records:** annotated, never deleted, each keeping a `revocation` object naming actor, reason and time.
- **Gate:** the acceptance gate names the withdrawal; reconciliation republishes a refusing check.

## The post-deployment smoke proof

`e2e:deploy-smoke` is the one proof submitted after delivery, only under a work policy setting `deploySmoke`.

- **`sha`:** the deployed commit the checks ran against, recorded by the `deployment` command.
- **`baseSha`:** the item's merge commit.

1. The [master loop](../master-agent.md#operate) records the deployment with `POST /api/work/UUID/deployment` ([who and when](work-commands.md#commands)) once the running release serves the merge commit, exactly or through a descendant.
4. `scripts/deploy-smoke.mjs publish`, in a separate job holding the producer secret, submits the evidence.

