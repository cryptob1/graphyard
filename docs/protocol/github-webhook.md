<!-- page: Agent protocol | 6 | webhooks, providers. -->
# GitHub webhook and review providers

For an integration author: how provider events reach Graphyard.

## Webhooks

A signed webhook only wakes durable jobs: every fact is read back through the App; an unsigned or unknown payload is ignored.

## Review provider changes and re-review

`POST /api/work/:id/reviewpolicy`:

- **Caller:** `admin` or an operator agent holding `policy:review-provider`.
- **Body:** `{ "provider": "github"|"codex"|"agent", "expectedPolicyRevision": 1, "reason": "…" }`.
- **Effect:** changes only the source of an already-required review, increments the policy revision, preserves criteria and CI requirements, invalidates prior acceptance, never mutates lifecycle state.
- **`provider: "agent"`:** also requires `reviewerProfiles`; every other provider rejects the field.
- **`reviewerProfiles`:** an ordered, nonempty list of `{ "name", "runtime", "reviewerApp", "mention"?, "timeoutSeconds"? }` ([examples](../../examples/reviewer-profiles.json)), names and reviewer Apps unique within the policy, each `reviewerApp` registered with the same runtime.
- **CLI:** `reviewpolicy GY-N agent POLICY_REVISION REASON --profiles FILE`.

`POST /api/work/:id/rereview`:

- **Caller never supplies:** a verdict, reviewer identity or comment ID.

## Identity-bound agent review

The invariant is *an approving identity distinct from the author reviewed this exact head*, not a vendor.

- **Register:** each reviewer App once with `github-setup HTTPS_URL --reviewer NAME`, requesting exactly the [reviewer declaration](../github.md#app-permissions).
- **Credentials:** `.graphyard/github-reviewer-<name>.json` at mode 0600, never sent to Graphyard; the reviewer runtime authenticates as that App.
- **`GRAPHYARD_REVIEWER_APPS`:** every reviewer, shaped like [examples/reviewer-apps.json](../../examples/reviewer-apps.json): `[{ "id": "claude-reviewer", "runtime": "claude", "appId": 1550001, "botUserId": 1550002 }]`.
- **Server start:** refused if a registered reviewer shares the control-plane App ID.
- **Policy:** names only a registered reviewer.
- **`GET /api/status`:** advertises `agent` once one is registered and the App holds its dispatch permissions.

```
<!-- graphyard-verdict:MARKER head:FULL_40_CHAR_SHA verdict:approved -->
```

## Codex cloud adapter

Graphyard dispatches a fresh `@codex review` comment through its own App and records the returned comment ID against the exact head, base and policy revision with a unique marker, so no earlier comment can be imported as an approval.

- **App needs:** Pull requests: write and Issues: read; Codex cloud connected, automatic reviews enabled.

## Automatic dispatch at submit

Every evaluation of a submitted item past the build gate records under `autoDispatch` what the exact head still needs from a launched session.

- **`satisfied`:** an approval or verdict on the head, a carried approval, or trusted evidence for every proof of the group.
- **`cancelled`:** with its reason, when the head, base or policy revision changes, rework is requested, or the pull request closes or merges.
- **`autoDispatch.history`:** resolved requests, the last fifty, each transition appending a `dispatch.requested`, `dispatch.satisfied` or `dispatch.cancelled` event.

Nothing here moves a gate ([what the loop launches](../master-agent.md#automatic-dispatch-at-submit)).
