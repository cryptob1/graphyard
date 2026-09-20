<!-- page: Agent protocol | 6 | webhooks and review providers. -->
# GitHub webhook and review providers

For an integration author: how provider events reach Graphyard.

## Webhooks

A signed webhook only wakes durable jobs: every fact is read back through the App, and an unsigned or unknown payload is ignored.

## Review provider changes and re-review

`POST /api/work/:id/reviewpolicy` requires `admin` or an operator agent holding `policy:review-provider` and accepts `{ "provider": "github"|"codex"|"agent", "expectedPolicyRevision": 1, "reason": "…" }`. It changes only the source of an already-required review, increments the policy revision, preserves criteria and CI requirements, invalidates prior acceptance, and cannot mutate lifecycle state. `provider: "agent"` also requires `reviewerProfiles`: an ordered, nonempty list of `{ "name", "runtime", "reviewerApp", "mention"?, "timeoutSeconds"? }` ([examples](../../examples/reviewer-profiles.json)) with names and reviewer Apps unique within the policy and each `reviewerApp` already registered with the same runtime; every other provider rejects the field. The CLI form is `reviewpolicy GY-N agent POLICY_REVISION REASON --profiles FILE`. `POST /api/work/:id/rereview` queues a fresh provider request and, for an agent policy, restarts failover at the first profile: an `admin` sends `{}`, a worker `{ "epoch": 1 }` while owning the active lease, and the caller never supplies a verdict, reviewer identity or comment ID.

## Identity-bound agent review

The invariant is *an approving identity distinct from the author reviewed this exact head*, not a particular vendor. Register each reviewer App once with `github-setup HTTPS_URL --reviewer NAME`, which requests exactly the [reviewer declaration](../github.md#app-permissions) and stores credentials in `.graphyard/github-reviewer-<name>.json` at mode 0600 — never sent to Graphyard, since the reviewer runtime authenticates as that App. Add every reviewer to `GRAPHYARD_REVIEWER_APPS`, shaped like [examples/reviewer-apps.json](../../examples/reviewer-apps.json): `[{ "id": "claude-reviewer", "runtime": "claude", "appId": 1550001, "botUserId": 1550002 }]`. Registration is the identity boundary — `appId` and `botUserId` are numeric GitHub identities, not display names, all three IDs must be unique, and the server refuses to start if a registered reviewer shares the control-plane App ID. A policy may name only a registered reviewer, and `GET /api/status` advertises `agent` once one is registered and the App holds its dispatch permissions.

```
<!-- graphyard-verdict:MARKER head:FULL_40_CHAR_SHA verdict:approved -->
```

## Codex cloud adapter

Graphyard dispatches a fresh `@codex review` comment through its own App and records the returned comment ID against the exact head, base and policy revision with a unique marker, so no previously posted comment can be imported as an approval. The App needs Pull requests: write and Issues: read, with Codex cloud connected and automatic reviews enabled.

## Automatic dispatch at submit

Every evaluation of a submitted item past the build gate records under `autoDispatch` what the exact head still needs from a launched session: `review`, one request when the policy expects a GitHub verdict, no approval binds the head and the head contains the base tip; and `producers`, one request per proof group (`unit`, `integration`, and `manual` for proofs in `producerProofs`) naming the proofs no trusted passing evidence binds. Each carries `id`, `kind`, `sha`, `baseSha`, `policyRevision`, `pr`, `requestedAt`, `reason` and `state`, a producer request also `group` and `proofs`; the `id` derives from what the request binds and when, so a launcher starts at most one session per `id`. A request is `satisfied` by an approval or verdict on the head, a carried approval, or trusted evidence for every proof of the group, and `cancelled` with its reason when the head, base or policy revision changes, rework is requested, or the pull request closes or merges. Resolved requests move to `autoDispatch.history` (the last fifty), each transition appending a `dispatch.requested`, `dispatch.satisfied` or `dispatch.cancelled` event. Nothing here moves a gate ([what the loop launches](../master-agent.md#automatic-dispatch-at-submit)).
