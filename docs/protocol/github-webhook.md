<!-- page: Agent protocol | 11 | webhook verification, review-provider changes, re-review, and the work snapshot. -->
# GitHub webhook and review providers

`POST /api/github/webhook` uses GitHub HMAC verification instead of a bearer token. It validates the repository and delivery ID, deduplicates deliveries in Postgres, and wakes durable jobs. Own-App check events are ignored to prevent publication loops. The payload never directly marks a gate passed.

## Review provider changes and re-review

`POST /api/work/:id/reviewpolicy` is operator-only and accepts `{ "provider": "codex", "expectedPolicyRevision": 1, "reason": "Adopt agent review" }` (provider may also be `github` or `agent`). It changes only the source of an already-required review, increments policy revision, preserves criteria/CI, and invalidates prior acceptance by version. It cannot mutate lifecycle state directly.

`provider: "agent"` additionally requires `reviewerProfiles`: an ordered, nonempty list of `{ "name", "runtime", "reviewerApp", "mention"?, "timeoutSeconds"? }`, as in [examples/reviewer-profiles.json](../../examples/reviewer-profiles.json). Names and reviewer Apps must be unique within a policy, and each `reviewerApp` must already be registered in the server's reviewer registry with the same runtime. Every other provider rejects `reviewerProfiles`. The first profile is dispatched and the rest are failover capacity; exhaustion appends a `review.failover` history entry and advances to the next profile, and the review gate stays closed once all are exhausted. `GET /api/status` lists the registered reviewer identities and advertises `agent` in `reviewProviders` when one is available.

`POST /api/work/:id/rereview` queues a fresh provider request for a `codex` or `agent` policy, and for an agent policy also restarts failover at the first profile. Operators send `{}`; workers send `{ "epoch": 1 }` and must own the active lease. The caller never supplies a verdict, reviewer identity, or comment ID. Only the trusted integration job records the actual dispatched request and any failover. Both endpoints require normal idempotency headers and append history. See the [GitHub guide](../github.md#identity-bound-agent-review-providers) for deployment, reviewer-App registration and branch-protection prerequisites.

`GET /api/work-snapshot` returns `{ work: WorkItem[], now: ISO8601 }` from a single Postgres statement snapshot, ordered by work number. Use its timestamp for lease display and preserve it with the returned work. `/api/work` retains its array response for existing clients; `/api/status.now` is a separate observation and must not be used to age another snapshot.
