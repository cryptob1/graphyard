# Agent protocol and HTTP API

All control-plane endpoints except `/healthz` require `Authorization: Bearer TOKEN`. Use HTTPS for remote machines. API credentials are not Git credentials.

## Roles

| Role | Permissions |
| --- | --- |
| `admin` | Create/release work, participate as a worker, attest manual proofs |
| `coordinator` | Read work and integration state for master-agent routing; acquire, verify, or cancel only the engine's bounded merge execution authority |
| `operator-agent` | Only explicitly configured intent/policy capabilities within a server-enforced repository/work allowlist; never leases, evidence, identity administration, or merge execution |
| `worker` | Claim work, renew/release own lease, register workspace, report blockers, submit implementation, submit untrusted assertions |
| `producer` | Submit evidence; only configured `proofs` are trusted |
| `reader` | Inspect work, status, events |

Except for operator-agents, all roles can read engineering metadata in this single-repository installation and have no per-item read ACL in v0.1. Operator-agent reads are restricted to their server-enforced repository/work scope allowlist. Each independent worker process should have a distinct principal; sharing a token makes processes indistinguishable.

## Requests and retries

Every mutation requires `Idempotency-Key`, at most 200 characters. Generate a UUID once and reuse it only when retrying the identical request after a timeout. A successful replay returns the original result without repeating the command. Different input under the same key returns `409`.

Errors return JSON `{ "error": "actionable reason" }`. Invalid JSON/schema is `400`, unauthenticated is `401`, wrong role is `403`, unknown route/item is `404`, coordination refusal is `409`, and oversize input is `413`. Do not retry a coordination refusal blindly; read status and resolve its reason.

## Read endpoints

| Method and path | Result |
| --- | --- |
| `GET /healthz` | Database reachability, no token required |
| `GET /api/status` | Current principal, integration configuration, failed jobs, server time |
| `GET /api/work-snapshot` | Work, integration job metadata and database time from one snapshot |
| `GET /api/work` | Work aggregates, in creation order |
| `GET /api/events?work=UUID` | Latest 300 events for one item; omit filter for latest global events |

The initial list API is unpaginated. Do not use it as an unlimited analytics export. Event payload snapshots can reconstruct historical item revisions; full archival/export pagination is future work.

## Work commands

Create with `POST /api/work` and the structure in [examples/work.json](../examples/work.json). Required fields are `title` and nonempty `criteria`; each criterion requires a unique `AC-N` ID, text, and at least one proof. The policy defaults to checks `test` and `typecheck`, plus independent review. Dependencies refer to existing UUIDs. Operator requirement revisions explicitly reject cycles. Optional `exclusiveResources` reserves named resources during active ownership; `plannedFiles` supplies advisory overlap scopes.

Other commands use `POST /api/work/UUID/COMMAND` (display keys also work):

| Command | JSON body |
| --- | --- |
| `requirements` | Full criteria, dependencies, plannedFiles, exclusiveResources, expectedPolicyRevision and reason; operator only, see [coordination](coordination.md) |
| `ready` | Admin: `{}`. Operator-agent: `{"expectedRevision":12,"reason":"Requirements approved"}` with the current work revision and a nonblank audit reason. |
| `unblock` | Admin: `{"reason":"Contract verified"}`. Operator-agent: `{"expectedRevision":12,"reason":"Contract verified"}` with the current work revision and a nonblank audit reason. |
| `rework` | `{"reason":"Retry implementation","previousWorkerStopped":true}`; operator only |
| `recover` | `{"reason":"Verified delivered worker stopped","previousWorkerStopped":true}`; operator only, delivered quarantine only |
| `claim` | `{}`; returns current lease and epoch |
| `heartbeat` | `{"epoch":1}` |
| `release` | `{"epoch":1}` |
| `blocked` | `{"epoch":1,"reason":"Waiting for API contract"}`; null clears |
| `workspace` | `{"epoch":1,"host":"build-machine-a","path":"/work/GY-1","branch":"graphyard/gy-1-1"}` |
| `submit` | `{"epoch":1,"pr":123}` |
| `evidence` | See below |
| `revoke` | See [revocation](#revocation) |

No endpoint sets arbitrary lifecycle state. `complete` in the CLI maps to `submit`, not `done`.

## Leases

Claims last 120 seconds. Renew at least every 30 seconds; the CLI supervisor uses 25 seconds. All owner mutations include the epoch. A database-clock expiry or superseding claim rejects the old owner even if it still holds an old response. A heartbeat cannot revive an expired lease.

If communication fails, stop implementation and pushing until ownership is re-established. `graphyard watch` follows this rule and terminates the worker's process group on failed renewal. An independently detached daemon is outside that supervision boundary.

Run `watch` from the registered workspace on its registered host. Every automatic heartbeat uses a fresh idempotency key, even when `GRAPHYARD_REQUEST_ID` is set for command retries. The supervisor uses elapsed local time and the server's granted lease duration, so host clock offsets do not extend ownership. A stalled renewal cannot extend the deadline. On lease loss, interruption, or worker exit, it stops renewing, sends SIGTERM to the process group, and sends SIGKILL after a five-second grace period, including to surviving descendants. Foreground contained launches first persist an epoch-bound quarantine. Establishment uses a cryptographically random parent-only settlement capability and a request key generated once per `watch` invocation, boundedly retries ambiguous responses with the exact same body and key, and will not launch until the response confirms the matching hash and exclusive resources. Neither the capability nor a derivation secret is placed in the child environment or durable history. If bounded reconciliation remains ambiguous, launch is abandoned and operator stopped-worker recovery is the terminal safe path. While quarantined, requirements (including exclusive resources) remain immutable. After SIGKILL the supervisor boundedly polls the scope until systemd reports it inactive or failed. A transient scope that has already unloaded is also empty only when systemd specifically reports `LoadState=not-found`; manager connection errors and other query failures remain unverifiable. Once shutdown is verified, settlement reuses one immutable capability-bearing body and idempotency key for bounded retries. HTTP 408 and 429 remain ambiguous even with JSON bodies; only a structured Graphyard refusal on another 4xx is definitive. Success must reconcile the exact assignment epoch, locally verified capability hash, and exclusive-resource fence; confirmed refusals are not retried, and persistent or mismatched ambiguity fails closed with the quarantine retained. The capability remains parent-only and never enters child environment or durable history. Capability-authorized settlement remains valid if delivery reaches Done during shutdown, while every other delivered mutation stays forbidden. Claims remain refused after lease expiry on timeout or unverifiable shutdown until settlement or an operator attests the previous worker stopped through rework. `diagnose` reports this task-local quarantine before unowned-task advice and directs capability settlement or operator stopped-worker recovery instead of suggesting an impossible fresh claim. If delivery has already reached Done, `recover-containment --previous-worker-stopped` clears only that quarantine after the operator attestation; it preserves Done, candidate, merge, requirement, evidence, and delivery history and cannot reopen or reassign the item. Linux fallback traversal caches the root's `/proc/<pid>/stat` kernel start-time ticks immediately after spawn and revalidates every cached parent before discovering or signaling descendants. If the root identity could not be captured, fallback cleanup stays empty instead of enrolling a later process that reused the PID. Process-group supervision targets Linux/macOS; Windows does not provide the same descendant containment.

`watch` requires a `worker` credential, even though operators may use manual claim commands. It removes the known Graphyard server credential variables from the child's environment. Keep worker machines and readable files free of operator/producer secrets too; environment filtering is not a sandbox or a general-purpose secret detector.

Submitted work continues through gates without an active implementation lease. To reassign submitted work, an operator must stop the previous process and request `rework`. This clears ownership and closes the build gate while preserving PR attribution. A new claim gets a higher epoch and must register the same PR branch in a fresh host/path. Resubmission closes the rework request. Rework of an observed merged item is refused; create a follow-up instead.

Foreground quarantine now also records a durable startup acknowledgement before process creation. `watch` transactionally acknowledges the exact live epoch, settlement hash, and resource fence with a stable request key, and only a confirmed response permits spawn. That transaction records a separate 120-second launch-authority deadline, longer than the acknowledgement client's three bounded 30-second HTTP attempts and retry delays. Rework cannot clear the quarantine until both its lease and launch authority have expired, so an acknowledgement response still in flight cannot authorize a stale later spawn. The supervisor measures the returned authority against monotonic elapsed request time and refuses spawn if it is no longer valid. A crashed supervisor therefore has a bounded recovery path: after both deadlines expire, an operator who has stopped the supervisor may use the existing stopped-worker rework attestation to clear the fence.

## Workspaces

Herdr may create worktrees itself. Register the exact branch and a stable machine ID before submitting the PR. Branches must begin `graphyard/`. A branch is globally unique in this control plane; paths are unique per host, including historical reservations. Use the assignment epoch in path and branch names.

Paths are normalized lexically; aliases through `..`, repeated separators, and nested reservations on the same host are rejected as overlaps. The server cannot resolve remote symlinks or detect two host IDs naming the same machine. Use canonical paths and stable host IDs. For submitted rework, `next` includes the item and `worktree` preserves the linked PR branch. Fetch that branch first in a replacement clone; Git refuses if it is already checked out locally. No force-checkout or automatic cleanup is performed.

```sh
node /path/to/graphyard/bin/graphyard.mjs register GY-1 workspace.json
```

The server never assumes it can run Git on a remote host. Host/path registration is worker-reported; PR branch matching is provider-observed. Workspace cleanup is manual and must preserve uncommitted work.

The quarantine and live lease form the final launch fence. Its idempotent control-plane acknowledgement precedes process creation, and rework is transactionally refused for the entire live-lease response window. A stale, reassigned, expired, mismatched, or ambiguous acknowledgement never spawns the child; the supervisor retains its signal handlers through acknowledgement and any cancellation or settlement.

## Evidence

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

SHA fields are full 40-character lowercase Git SHAs. Results are `pass` or `fail`. Counts must be nonnegative integers. For manual acceptance, executed means the number of criteria actually inspected, not a fabricated test count.

The server supplies evidence ID, identity, timestamp, and trust. Clients cannot set `trusted` or `producer`. Unknown fields are rejected. A producer may submit a non-allowlisted proof, but it remains untrusted. A producer is a trust boundary, not a guarantee that its test was well designed.

All required proof names must pass. Evidence is selected for the exact head/base/policy tuple. A later matching failure supersedes an earlier pass. Stale evidence is retained for audit without satisfying the current candidate.

### Revocation

`POST /api/work/:id/revoke` withdraws accepted evidence that should no longer authorize a candidate:

```json
{
  "proof": "integration:claim-safety",
  "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "baseSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "policyRevision": 1,
  "reason": "Reported run was attributed to the wrong artifact"
}
```

Only an operator, or the trusted producer allowlisted for that exact proof name, may revoke; workers, coordinators, other producers and operator agents are refused. The tuple is pinned deliberately: a request that matches no trusted record refuses with 404 rather than silently withdrawing nothing.

Revocation withdraws *every* trusted record for that tuple, so an older accepted run cannot quietly re-authorize the same candidate. Records are annotated, never deleted; each keeps a `revocation` object naming the actor, reason and time. The acceptance gate then names the withdrawal explicitly instead of reporting the proof as merely unmeasured, and reconciliation republishes a refusing GitHub check. A later trusted run for the same candidate re-authorizes it normally.

Revocation may interrupt an active merge execution until the broker's transactional provider-commit boundary; it then serializes before the commit and cancels it, or serializes after it and refuses because the provider mutation is already irrevocably in flight. See [the merge broker](github.md#enforcement-boundary). Delivered work is immutable and refuses revocation: use a follow-up task.

## GitHub webhook

`POST /api/github/webhook` uses GitHub HMAC verification instead of a bearer token. It validates the repository and delivery ID, deduplicates deliveries in Postgres, and wakes durable jobs. Own-App check events are ignored to prevent publication loops. The payload never directly marks a gate passed.

### Review provider changes and re-review

`POST /api/work/:id/reviewpolicy` is operator-only and accepts `{ "provider": "codex", "expectedPolicyRevision": 1, "reason": "Adopt agent review" }` (provider may also be `github`). It changes only the source of an already-required review, increments policy revision, preserves criteria/CI, and invalidates prior acceptance by version. It cannot mutate lifecycle state directly.

`POST /api/work/:id/rereview` queues a fresh Codex request. Operators send `{}`; workers send `{ "epoch": 1 }` and must own the active lease. The caller never supplies a verdict, reviewer identity, or comment ID. Only the trusted integration job records the actual dispatched request. Both endpoints require normal idempotency headers and append history. See the GitHub guide for deployment and branch-protection prerequisites.

`GET /api/work-snapshot` returns `{ work: WorkItem[], now: ISO8601 }` from a single Postgres statement snapshot, ordered by work number. Use its timestamp for lease display and preserve it with the returned work. `/api/work` retains its array response for existing clients; `/api/status.now` is a separate observation and must not be used to age another snapshot.

## Validation runner API

The [validation protocol](validation.md) documents versioned environments, trusted registrations, immutable candidates, explicit dispatch/ACK, result collection and recovery. Use `graphyard validation` to inspect requests. Automatic runner execution is a later increment.

## Supervised shutdown invariants

The supervisor installs its SIGINT and SIGTERM handlers before attempting foreground quarantine establishment and retains them through bounded reconciliation, containment verification, and quarantine settlement. Immediately before spawn it performs a fresh, non-idempotent `work-snapshot` read and requires the authenticated worker principal, live unexpired lease epoch, capability hash, exclusive-resource fence, and exact epoch workspace registration to remain unchanged. An establishment receipt replay is never itself launch authority. A stale, reassigned, expired, mismatched, or ambiguous fresh read never launches a child. Because containment is then known never to have launched, the supervisor capability-settles a matching quarantine only when the same worker still has a live lease for that epoch; otherwise it retains the fence for operator recovery. If interrupted before launch, it never starts the worker: it finishes bounded establishment reconciliation with the original request key and body, then capability-settles any confirmed quarantine with bounded stable-key retries. Persistent establishment ambiguity fails closed with the quarantine potentially retained for operator recovery. Repeated signals continue to target this same prelaunch or already-started shutdown flow instead of killing the capability-holding parent; handlers are removed only immediately before the supervisor finally resolves or rejects, including establishment refusal, ambiguity, settlement failure, and success. Capability-authorized settlement is permitted while a merge execution is active or expired, but clears only the containment quarantine and preserves merge authority, gates, and merge history.
