<!-- page: Agent protocol | 5 | webhook and dispatch records. -->
# GitHub webhook and review providers

`POST /api/github/webhook` verifies GitHub's HMAC instead of a bearer token, deduplicates deliveries and wakes durable jobs; a payload never marks a gate passed.

The `X-GitHub-Event` header decides what a delivery does beyond waking jobs:

- `pull_request`, `pull_request_review`, `check_run`, `check_suite` and `push`: the woken items are claimed ahead of polled jobs, by whichever replica claims next. A `push` to any other branch wakes the item whose candidate is on that branch.
- A `push` to the base branch: also ends the shared base-ref read.
- `branch_protection_rule`, `branch_protection_configuration`, `repository_ruleset` and `repository`: end the shared protection read.

See [reads that are not repeated](../operations-reference.md#reads-that-are-not-repeated).

`POST /api/work/:id/reviewpolicy` (`admin`, or an operator agent with `policy:review-provider`) takes `{"provider":"codex"|"github"|"agent", "expectedPolicyRevision":1, "reason":…}`, bumping the policy revision; `agent` also needs ordered `reviewerProfiles` (`name`, `runtime`, `reviewerApp`, optional `mention` and `timeoutSeconds`).

## Automatic dispatch records

`autoDispatch` records each [automatic dispatch](../master-agent.md#automatic-dispatch-at-submit) as a `producers` or `review` request with `id`, `kind`, `sha`, `baseSha`, `policyRevision`, `pr`, `requestedAt`, `reason` and `state`. A request is `satisfied` by an approval or trusted evidence, `cancelled` when the head, base or policy changes, rework is requested or the PR closes; transitions append `dispatch.requested`, `dispatch.satisfied` or `dispatch.cancelled`, and resolved requests move to `autoDispatch.history`. Nothing here moves a gate.
