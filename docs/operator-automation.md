<!-- page: Operate Graphyard | 10 | least-privilege operator agents. -->
# Scoped operator-agent automation

For the operator enabling autonomy: which capabilities an agent holds, and what is denied.

## Authority model

An `operator-agent` is not the human operator and holds no `admin` authority. Each capability bounds one operation:

- `intent:create`: Create a validated work intent
- `intent:ready`: Release an in-scope backlog item
- `intent:unblock`: Clear an in-scope blocker with a reason
- `policy:requirements`: Add requirements or containment, never remove or rewrite them
- `policy:review-provider`: Select a supported required review provider, creating a new policy revision
- `policy:bootstrap`: Declare or change bootstrap mode on a criterion
- `decision:resolve`: Request resolution of a standing escalation
- `decision:attest`: Request attestation of a `manual:` proof on the exact candidate
- `decision:merge`: Request merge approval for the exact candidate when automatic merging is off
- `decision:rework`: Request rework, or containment recovery of a delivered item, attesting the previous worker stopped
- `decision:grant`: Request a proof-authority grant to a producer principal
- `decision:approve`: Approve another identity's decision; never its own, never on an item it held, never one resting on its own evidence

## Master autonomy setup

Run once, as the human operator, with the `admin` credential on stdin; it provisions the identities and is never stored:

```sh
graphyard master autonomy                                   # preview: identities, capabilities, harness rules
printf '%s' "$ADMIN_TOKEN" | graphyard master autonomy --admin-token-stdin --apply
```

## Two-party decisions

Every decision the guides once reserved for the human operator, other than the three human-only ones, is a two-party decision on one work item.

1. The master requests it: `master decide GY-N ACTION [JSON|@FILE] REASON`, sending `POST /api/work/GY-N/decide`. Actions are `release`, `unblock`, `requirements`, `resolve`, `attest`, `merge`, `rework`, `recover` and `grant`. The CLI fills the binding from the item's current state, and the request is refused unless the requester holds the action's capability and the item is still in the state it names; one decision per action may be open at a time.
2. `master approver GY-N DECISION` launches a separate session running as the approver identity, prompted to judge the reason against the item and the operator's goals.
3. `master approve GY-N DECISION REASON` applies it. The server refuses, naming the conflict, when the approver requested the decision, has held an assignment on the item, produced evidence the decision rests on, or is the principal a `grant` would empower; it re-checks the requester's live authority and the item's state first.

## Harness rules per role

`master autonomy --apply` installs the master's own harness rules, which also deny pointing a command at another identity's credential file, and dispatch installs each worker's rules in its assigned worktree. The master may run its own CLI subcommands at their absolute path, `herdr`, read-only `gh pr`, `gh api user`, `gh api` reads of the base branch's protection and `--method PATCH` writes to its subresources, `gh api user/installations` and `gh api apps/*` reads, `jq`, the audited-thread wrapper, reads of `.graphyard/master-actions/` and writes to `.graphyard/profiles/`. It is denied `gh pr merge`, `gh pr review`, any `gh api` call that merges, posts a review, mints a token, uses GraphQL or uses `PUT`, `POST` or `DELETE`, every direct `agent-browser` command, `git push`, and reads of the coordinator credential home, `.graphyard/connection.json`, `*.pem` and `*.token`. Existing entries are never removed and regeneration is idempotent.

| Role | May | May not |
| --- | --- | --- |
| worker | push its assigned branch (`origin BRANCH`, `-u`, `HEAD:BRANCH`), run its item's Graphyard commands, open its pull request | force-push, push the base branch, rebase, merge, post a review, submit evidence |
| reviewer | read the diff and post the one verdict it was launched for | push, commit, claim, submit evidence, edit files |
| producer | fetch, add and remove its detached worktree, submit evidence | push, commit, claim, post a review |

## Other operator agents

Keep a random secret of at least 32 characters in a password manager and put only non-secret configuration — `id`, `displayName`, `capabilities`, `scope`, `reason` — in a file. Pass the secret on stdin: `printf '%s' "$SECRET" | graphyard operator-agent setup operator.json --token-stdin`, then `graphyard operator-agent list`. Prefer explicit work IDs over `"*"`. The dashboard's **Operator automation** view shows the redacted identity, fingerprint, capabilities, scopes, revision, revocation state and last mutation; plaintext secrets are never returned or stored. `operator-agent configure ID FILE` changes scope, requiring `expectedRevision` and complete replacement lists. `operator-agent rotate ID SECONDS REASON --token-stdin` issues a new credential with a bounded overlap — zero for immediate cutover, at most 24 hours — so verify the new fingerprint before it ends, and never extend recovery by sharing the admin token. `operator-agent revoke ID REASON` is immediate and fail-closed for every active or transitional credential, and a revoked identity is retained for audit. Never answer a denial by weakening gates: reload the current revisions, confirm the approved capability and scope, and retry with a fresh idempotency key only for a changed request.

## Threat model

A stolen credential exercises only its configured capabilities and targets, so revoke it and inspect the immutable events; every route checks authenticated role, capability, repository and work scope, and an agent cannot edit its own scope or credentials. Startup fails closed when a repository-bound engine is paired with an adapter for another repository, expected revisions reject stale policy edits, and idempotency receipts reject changed reuse. The role has no lease commands and no evidence or validation authority of its own — a `manual:` attestation needs an approved `attest` decision. Against self-approval and collusion the server refuses, and records, an approver that requested the decision, held an assignment, produced the evidence or would receive the grant; the master's session refuses `master approve`, and its harness rules deny pointing a command at another identity's credential file, which is why each approver runs in its own launched session. Secrets travel on stdin, responses and events carry fingerprints only, and revoking the identity returns coordination to the human operator while history remains.
