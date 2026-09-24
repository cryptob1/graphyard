<!-- page: Operate Graphyard | 10 | operator agents and two-party decisions. -->
# Scoped operator-agent automation

Enable it after the repository's gates are active. The human operator opts in once; from then on master, approver, workers and reviewers are separate sessions and principals.

## Authority model

An `operator-agent` has no `admin` authority, only listed capabilities within a repository/work allowlist: `intent:create`, `intent:ready`, `intent:unblock`, `policy:requirements` (add only), `policy:review-provider`, `decision:resolve|attest|merge|rework|grant` (request), `decision:approve`. Every write needs a reason, idempotency key and current revision. Operator agents never claim, implement, submit evidence or merge.

## Master autonomy setup

```sh
graphyard master autonomy                                   # preview
printf '%s' "$ADMIN_TOKEN" | graphyard master autonomy --admin-token-stdin --apply
```

This provisions `graphyard-master-REPO-operator` (intent, policy and every decision request) and `graphyard-approver-REPO` (`decision:approve`), with 0600 credentials outside every worktree recorded in `.graphyard/master.json`.

## Two-party decisions

1. `graphyard master decide GY-N ACTION [JSON|@FILE] REASON` — actions `release`, `unblock`, `requirements`, `resolve`, `attest`, `merge`, `rework`, `recover`, `grant`.
2. `graphyard master approver GY-N DECISION` launches the approver session.
3. `graphyard master approve GY-N DECISION REASON` applies it. Self-approval, an approver that held the item, produced its evidence, or would receive the grant is refused.

`graphyard master decisions GY-N` lists states (`requested`, `approved`, `applied`, `failed`). A `failed` decision needs a new request.

## Other operator agents

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
graphyard operator-agent configure planning-agent operator-scope.json
printf '%s' "$REPLACEMENT_SECRET" | graphyard operator-agent rotate planning-agent 300 "Quarterly rotation" --token-stdin
graphyard operator-agent revoke planning-agent "Automation paused after suspected exposure"
```

Secrets are 32+ random characters, passed on stdin. Rotation overlap is at most 24 hours; revocation is immediate and permanent.
