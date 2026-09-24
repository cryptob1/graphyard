<!-- page: Agent protocol | 12 | webhook, review providers, and automatic dispatch. -->
# GitHub webhook and review providers

`POST /api/github/webhook` uses GitHub HMAC verification instead of a bearer token, deduplicates deliveries in Postgres, and wakes durable jobs. Own-App check events are ignored. A payload never marks a gate passed.

## Review provider changes and re-review

`POST /api/work/:id/reviewpolicy` (`admin`, or an operator agent with `policy:review-provider`) takes `{ "provider": "codex", "expectedPolicyRevision": 1, "reason": "Adopt agent review" }`; provider may also be `github` or `agent`. It bumps the policy revision and invalidates prior acceptance.

`provider: "agent"` requires `reviewerProfiles`: an ordered list of `{ "name", "runtime", "reviewerApp", "mention"?, "timeoutSeconds"? }` (see [examples/reviewer-profiles.json](../../examples/reviewer-profiles.json)), each `reviewerApp` registered in the server's reviewer registry. The first profile is dispatched; the rest are failover (`review.failover`).

`POST /api/work/:id/rereview` queues a fresh request for a `codex` or `agent` policy: `{}` from an `admin`, `{ "epoch": 1 }` from the lease holder. See [GitHub](../github.md#identity-bound-agent-review-providers).

## Automatic dispatch at submit

When a submitted candidate passes the build gate, the item records under `autoDispatch` what the exact head still needs: a `review` request (when a GitHub verdict is expected and no approval binds the head) and one `producers` request per proof group (`unit`, `integration`, and `manual` for `producerProofs`). Each request carries `id`, `kind`, `sha`, `baseSha`, `policyRevision`, `pr`, `requestedAt`, `reason` and `state`; launchers start at most one session per `id`.

A request is `satisfied` by an approval or by trusted evidence for its proofs, and `cancelled` when the head, base or policy changes, rework is requested, or the PR closes. Transitions append `dispatch.requested`, `dispatch.satisfied` or `dispatch.cancelled`; resolved requests move to `autoDispatch.history`. Nothing here moves a gate. See the [master guide](../master-agent.md#automatic-dispatch-at-submit).
