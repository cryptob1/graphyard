# Scoped operator-agent automation

## Bootstrap boundary

Graphyard starts in the safer mode: one implementation agent works under direct human supervision. No operator-agent credential, multi-agent routine, or automated coordinator is required. Connect Graphyard's own repository, activate its delivery gates, and demonstrate the complete protected path before enabling operator automation.

Only a human administrator may opt in. After opt-in, keep four distinct AI sessions and identities: the **Operator** expresses bounded intent, the **Master** observes and coordinates routine delivery, the **Worker** implements in an assigned worktree, and the **Reviewer/proof-producer** independently reviews or produces trusted proof. The human supplies goals, approval decisions, exceptions, and oversight. Do not collapse these sessions or share credentials between them.

## Authority model

An `operator-agent` is not an administrator. Its server-loaded identity contains an explicit capability list and repository/work allowlist; missing entries deny access. Available capabilities are:

| Capability | Bounded operation |
| --- | --- |
| `intent:create` | Create a validated work intent |
| `intent:ready` | Release an in-scope backlog item |
| `intent:unblock` | Clear an in-scope blocker with a reason |
| `policy:requirements` | Add requirements or containment, never remove or rewrite them |
| `policy:review-provider` | Select a supported required review provider, creating a new policy revision |

Every permitted write requires an explicit reason and idempotency key, validates bounded schemas and current revisions (`expectedRevision` for ready/unblock and `expectedPolicyRevision` for policy changes), runs in the coordination transaction, attributes the authenticated principal, and appends before/after work state and the reason to immutable history. Operator-created work always requires independent review; `intent:create` cannot disable that gate. External I/O remains outside that transaction.

Operator agents cannot claim, heartbeat, register, release, implement, or submit work; create or submit evidence; use validation producer/runner routes; administer identities or their own scope; acquire coordinator merge authority; or call an administrative merge path. They cannot remove requirements, dependencies, planned-file containment, or exclusive resources. Credential status and route authorization are checked on every request.

## Human-admin setup

Choose a random secret of at least 32 characters and keep it in a password manager. Put only non-secret configuration in `operator.json`:

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
- **Stale/replayed requests:** expected revisions reject stale policy edits; idempotency receipts return the identical result and reject changed reuse.
- **Lease races:** the role has no lease commands. Existing principal identity and epoch checks continue to fence workers.
- **Evidence forgery and session collapse:** operator automation has no evidence or validation authority. Keep reviewer/proof-producer, worker, master, and operator sessions distinct.
- **Secret exposure:** stdin avoids process arguments; responses, UI, events, and stored agent documents contain fingerprints only. Database credential hashes still require normal database protection.
- **Partial rotation and lockout:** bounded overlap permits verification; a human admin can rotate or revoke. Retain an offline recovery path for the admin credential.
- **Rollback:** revoke the identity to return to human-operated coordination. Existing immutable history remains; do not delete it or relax delivery gates.
