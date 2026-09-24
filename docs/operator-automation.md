<!-- page: Operate Graphyard | 10 | least-privilege operator agents with server-enforced scope. -->
# Scoped operator-agent automation

Enable operator automation only after the repository's gates are active and the protected path has been demonstrated under one supervised worker. The human operator opts in once (`graphyard master autonomy`); from then on the master, approver, workers and reviewers/producers are separate sessions with separate principals.

## Authority model

An `operator-agent` holds no `admin` authority: only its listed capabilities within a repository/work allowlist.

| Capability | Operation |
| --- | --- |
| `intent:create`, `intent:ready`, `intent:unblock` | Create, release, unblock in-scope work |
| `policy:requirements` | Add requirements or containment, never remove or rewrite |
| `policy:review-provider` | Select the review provider (new policy revision) |
| `decision:resolve`, `decision:attest`, `decision:merge`, `decision:rework`, `decision:grant` | Request that decision |
| `decision:approve` | Approve another identity's decision |

Every write needs a reason, an idempotency key and the current revision, and is appended to history. Operator agents cannot claim or implement work, submit evidence (except through an approved `attest`), administer identities, or merge.

## Master autonomy setup

Run once as the human operator; the admin credential is used and never stored:

```sh
graphyard master autonomy                                   # preview
printf '%s' "$ADMIN_TOKEN" | graphyard master autonomy --admin-token-stdin --apply
```

| Identity | Capabilities | Held by |
| --- | --- | --- |
| `graphyard-master-REPO-operator` | all `intent:*`, `policy:requirements`, `policy:review-provider`, and every `decision:*` request | The visible master session |
| `graphyard-approver-REPO` | `decision:approve` | An approver session per decision |

Credentials are written mode 0600 outside every worktree and recorded in `.graphyard/master.json`, with harness rules that deny reading other identities' credentials. The master then uses `graphyard master create|release|unblock|requirements`, `graphyard master principals [--apply]` and `graphyard master restart` without a human.

## Two-party decisions

1. Request: `graphyard master decide GY-N ACTION [JSON|@FILE] REASON` (`POST /api/work/GY-N/decide`). Actions: `release`, `unblock`, `requirements`, `resolve`, `attest`, `merge`, `rework`, `recover`, `grant`. The CLI binds the current revision or exact candidate.
2. Launch the approver: `graphyard master approver GY-N DECISION`.
3. Approve: `graphyard master approve GY-N DECISION REASON` (`POST /api/work/GY-N/approve`). The server refuses self-approval, an approver that held an assignment on the item, produced evidence the decision rests on, or would receive the grant, then re-checks state and applies.

`graphyard master decisions GY-N` lists each decision (`requested`, `approved`, `applied`, `failed`) with every refused approval; the ledger records `decision.requested|refused|approved|applied|failed`. A `failed` application (the item moved) needs a new request. With automatic merging off, `graphyard master merge` requires an approved `merge` decision.

## Human-admin setup

For other operator agents, keep a random secret of 32+ characters in a password manager and put only configuration in `operator.json`:

```json
{
  "id": "planning-agent",
  "displayName": "Planning operator",
  "capabilities": ["intent:create", "policy:requirements"],
  "scope": { "repositories": ["OWNER/REPOSITORY"], "workItems": ["*"] },
  "reason": "Approved for bounded planning after repository gates were demonstrated"
}
```

```sh
printf '%s' "$NEW_OPERATOR_SECRET" | graphyard operator-agent setup operator.json --token-stdin
graphyard operator-agent list
graphyard operator-agent configure planning-agent operator-scope.json   # expectedRevision + full lists + reason
```

## Rotation, revocation, and recovery

```sh
printf '%s' "$REPLACEMENT_SECRET" | graphyard operator-agent rotate planning-agent 300 "Quarterly rotation" --token-stdin
graphyard operator-agent revoke planning-agent "Automation paused after suspected exposure"
```

Rotation overlap is 0 seconds to 24 hours; verify the new fingerprint before it ends. Revocation is immediate and permanent; create a new identity after investigating. Never answer a denial by weakening gates or sharing the admin token. A stolen agent credential can use only its configured capabilities; revoke it and inspect the ledger. Keep each approver in its own session: two identities in one session defeat independence.
