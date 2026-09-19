<!-- page: Operate Graphyard | 10 | least-privilege operator agents with server-enforced scope. -->
# Scoped operator-agent automation

## Bootstrap boundary

Graphyard starts in the safer mode: one worker session works under the human operator's direct supervision. No operator-agent credential, multi-agent routine, or automated coordinator is required. Terms follow the [glossary](glossary.md). Connect Graphyard's own repository, activate its delivery gates, and demonstrate the complete protected path before enabling operator automation.

Only the human operator may opt in, once, at onboarding (`graphyard master autonomy`). After opt-in, autonomy is the default and the sessions are distinct, each with its own principal: the **master** coordinates delivery and, as its own operator-agent identity, expresses bounded intent and requests decisions; the **approver** is a separate session with a separate operator-agent identity that approves the master's decisions; the **worker** implements in an assigned worktree; and the **reviewer/proof producer** independently reviews or produces trusted proof. The human operator supplies only goals and priorities, spending money or opening third-party accounts, and credentials for people; every other approval is an agent's (see [Two-party decisions](#two-party-decisions)). Do not collapse these sessions or share credentials between them.

## Authority model

An `operator-agent` is not the human operator and holds no `admin` authority. Its server-loaded identity contains an explicit capability list and repository/work allowlist; missing entries deny access. Available capabilities are:

| Capability | Bounded operation |
| --- | --- |
| `intent:create` | Create a validated work intent |
| `intent:ready` | Release an in-scope backlog item |
| `intent:unblock` | Clear an in-scope blocker with a reason |
| `policy:requirements` | Add requirements or containment, never remove or rewrite them |
| `policy:review-provider` | Select a supported required review provider, creating a new policy revision |
| `decision:resolve` | Request resolution of a standing escalation |
| `decision:attest` | Request attestation of a `manual:` proof on the exact candidate |
| `decision:merge` | Request merge approval for the exact candidate when automatic merging is off |
| `decision:rework` | Request rework, or containment recovery of a delivered item, attesting the previous worker stopped |
| `decision:grant` | Request a proof-authority grant to a producer principal |
| `decision:approve` | Approve another identity's decision; never its own, never on an item it held, never one resting on its own evidence |

The `release`, `unblock` and `requirements` decisions need `intent:ready`, `intent:unblock` and `policy:requirements`. A `decision:*` or policy capability requests; nothing it requests changes an item until a second, independent identity holding `decision:approve` approves it.

Every permitted write requires an explicit reason and idempotency key, validates bounded schemas and current revisions (`expectedRevision` for ready/unblock and `expectedPolicyRevision` for policy changes), runs in the coordination transaction, attributes the authenticated principal, and appends before/after work state and the reason to immutable history. Operator-created work always requires independent review; `intent:create` cannot disable that gate. External I/O remains outside that transaction.

Operator agents cannot claim, heartbeat, register, release, implement, or submit work; submit evidence except through an approved `attest` decision; use validation producer/runner routes; administer identities or their own scope; acquire coordinator merge authority; or call an administrative merge path. Alone, they cannot remove or rewrite requirements, dependencies, planned-file containment, or exclusive resources; an approved `requirements` decision can. Credential status and route authorization are checked on every request.

## Master autonomy setup

Onboarding gives the master its agent identities in one step. Run it once, as the human operator, with the `admin` credential on stdin; the credential is used to provision the identities and is never stored:

```sh
graphyard master autonomy                                   # preview: identities, capabilities, harness rules
printf '%s' "$ADMIN_TOKEN" | graphyard master autonomy --admin-token-stdin --apply
```

It provisions (or repairs, by rotating a lost credential) two operator agents scoped to the repository and every work item:

| Identity | Capabilities | Held by |
| --- | --- | --- |
| `graphyard-master-REPO-operator` | `intent:create`, `intent:ready`, `intent:unblock`, `policy:requirements`, `policy:review-provider`, `decision:resolve`, `decision:attest`, `decision:merge`, `decision:rework`, `decision:grant` | The visible master session |
| `graphyard-approver-REPO` | `decision:approve` | An approver session launched per decision |

Their credentials are written mode 0600 beside the coordinator credential, outside every worktree, and `.graphyard/master.json` records their IDs and paths. The same run installs the master's harness rules, which also deny the master pointing a command at another identity's credential file. Dispatch installs each worker's own rules in its assigned worktree: its item commands, pushing its assigned branch, and opening its pull request, while force pushes, base-branch pushes, rebases, merges, reviews and credential reads stay denied. From then on the master creates, releases, unblocks and adds requirements with `graphyard master create|release|unblock|requirements`, previews and applies agent-principal rotation with `graphyard master principals [--apply]` (refused when it would drop a live principal or change its role), and restarts its own loop with `graphyard master restart`, none of which needs a human.

## Two-party decisions

Every decision the guides used to reserve for the human operator, other than goals and priorities, spending money or opening third-party accounts, and issuing credentials to people, is a two-party decision on one work item:

1. The master requests it: `graphyard master decide GY-N ACTION [JSON|@FILE] REASON`, which sends `POST /api/work/GY-N/decide` with `{ action, input, reason }`. Actions are `release`, `unblock`, `requirements` (including rewrites and removals), `resolve`, `attest`, `merge`, `rework`, `recover`, and `grant`. The CLI fills the binding from the item's current state: the revision, the policy revision, or the exact candidate head, base and policy revision. The request is refused unless the requester holds the action's capability and the item is still in the state it names; one decision per action may be open at a time.
2. The master launches the approver: `graphyard master approver GY-N DECISION`, a separate Herdr session running as the approver identity, prompted to judge the reason against the item and the operator's goals.
3. The approver approves: `graphyard master approve GY-N DECISION REASON` (`POST /api/work/GY-N/approve` with `{ decision, reason }`). The server refuses, naming the conflict, when the approver requested the decision (*self-approval*), has held an assignment on the item, produced evidence the decision rests on (any evidence on the item for `merge`, that proof's evidence for `attest`), or is the principal a `grant` would empower. It re-checks the requester's live authority and the item's state, then applies the decision.

`GET /api/work/GY-N/decisions` (`graphyard master decisions GY-N`) lists each decision with its state (`requested`, `approved`, `applied`, `failed`), requester, approver, reasons, outcome, and every refused approval. History is append-only: `decision.requested`, `decision.refused`, `decision.approved`, and `decision.applied` or `decision.failed` events, each naming the acting principal. An approved `resolve` or `merge` is applied in the approval's own transaction; `resolve` appends `escalation.resolved` with `resolvedBy`, `approvedBy` and both reasons. Every other action is applied through the ordinary command as the requester, bound to the recorded input, with the requester, approver and reasons in the command's own reason and an idempotency key derived from the decision, so an interrupted approval is resumed by the same approver without applying twice. A refusal at application (a stale revision, a candidate that moved) is recorded as `failed`; request the decision again. An approved `merge` decision is what `graphyard master merge` requires for each candidate when automatic merging is off; the guarded merge still rechecks every gate.

## Human-admin setup

For operator agents other than the master's own, choose a random secret of at least 32 characters and keep it in a password manager. Put only non-secret configuration in `operator.json`:

```json
{
  "id": "planning-agent",
  "displayName": "Planning operator",
  "capabilities": ["intent:create", "policy:requirements"],
  "scope": { "repositories": ["OWNER/REPOSITORY"], "workItems": ["*"] },
  "reason": "Approved for bounded planning after repository gates were demonstrated"
}
```

Pass the secret over stdin, never as an argument:

```sh
printf '%s' "$NEW_OPERATOR_SECRET" | graphyard operator-agent setup operator.json --token-stdin
graphyard operator-agent list
```

Prefer explicit work IDs/keys over `"*"` where practical. The dashboard's **Operator automation** view shows the redacted identity, fingerprint, capabilities, scopes, revision, revocation state, and last mutation. Plaintext secrets are neither returned nor placed in repository/UI state.

To modify scope, supply `expectedRevision`, the complete replacement capability/scope lists, and a reason in a JSON file:

```sh
graphyard operator-agent configure planning-agent operator-scope.json
```

The current revision prevents a stale admin edit from overwriting a newer decision.

## Rotation, revocation, and recovery

Rotation creates a new credential and bounds the old credential's overlap. Use zero seconds for immediate cutover, or the shortest operationally necessary transition (at most 24 hours):

```sh
printf '%s' "$REPLACEMENT_SECRET" | graphyard operator-agent rotate planning-agent 300 "Quarterly rotation" --token-stdin
graphyard operator-agent list
```

Verify the new fingerprint and credential before the transition ends. If verification fails, retry with a fresh secret while an old credential is still valid, or use the human admin credential to rotate again. Never extend recovery by sharing the admin token.

Revocation is immediate and fail-closed for every active or transitional credential:

```sh
graphyard operator-agent revoke planning-agent "Automation paused after suspected exposure"
```

A revoked identity is retained for audit and cannot be silently reactivated. Create a new identity after investigating the event. API denial guidance is intentionally conservative: reload current identity/work revisions, confirm the human-approved capability and target scope, and retry with a fresh idempotency key only for a changed request. Never solve a denial by weakening gates or requirements.

## Threat model

- **Credential theft and prompt injection:** the stolen agent can exercise only configured capabilities and targets. Revoke it immediately; inspect immutable events and affected work.
- **Confused deputy and scope escalation:** every route checks authenticated role, capability, repository, and work scope. The agent cannot edit its own scope or credentials.
- **Repository split binding:** startup fails closed when an explicitly repository-bound engine is paired with a GitHub adapter for another repository; status, webhooks, validation, and mutations must share one binding.
- **Stale/replayed requests:** expected revisions reject stale policy edits; idempotency receipts return the identical result and reject changed reuse.
- **Lease races:** the role has no lease commands. Existing principal identity and epoch checks continue to fence workers.
- **Evidence forgery and session collapse:** operator automation has no evidence or validation authority of its own; a `manual:` attestation needs an approved `attest` decision. Keep reviewer/proof producer, worker, master, and approver sessions distinct.
- **Self-approval and collusion:** the server refuses an approver that requested the decision, held an assignment on the item, produced the evidence it rests on, or would receive the grant, and records the refusal. The master's session refuses `master approve`, and its harness rules deny pointing a command at another identity's credential file. Two agent identities held by one session would still defeat independence, so each approver runs in its own launched session.
- **Secret exposure:** stdin avoids process arguments; responses, UI, events, and stored agent documents contain fingerprints only. Database credential hashes still require normal database protection.
- **Partial rotation and lockout:** bounded overlap permits verification; a human admin can rotate or revoke. Retain an offline recovery path for the admin credential.
- **Rollback:** revoke the identity to return to coordination by the human operator. Existing immutable history remains; do not delete it or relax delivery gates.
