<!-- page: Operate Graphyard | 10 | least-privilege operator agents. -->
# Scoped operator-agent automation

For the operator enabling autonomy: which capabilities an agent holds, and what is denied.

## Authority model

An `operator-agent` is not the human operator and holds no `admin` authority; each capability bounds one operation:

- `intent:create`: Create a validated work intent
- `intent:ready`: Release an in-scope backlog item
- `intent:unblock`: Clear an in-scope blocker with a reason
- `policy:requirements`: Add requirements or containment, never remove or rewrite
- `policy:review-provider`: Select a supported required review provider, creating a new policy revision
- `policy:bootstrap`: Declare or change bootstrap mode on a criterion
- `decision:resolve`: Request resolution of a standing escalation
- `decision:attest`: Request attestation of a `manual:` proof on the exact candidate
- `decision:merge`: Request merge approval for the exact candidate when automatic merging is off
- `decision:rework`: Request rework, or containment recovery of a delivered item, attesting the worker stopped
- `decision:grant`: Request a proof-authority grant to a producer principal
- `decision:approve`: Approve another identity's decision; never its own, never on an item it held, never one resting on its evidence

## Master autonomy setup

Run once as the human operator, `admin` credential on stdin; it provisions the identities and stores nothing:

```sh
graphyard master autonomy                                   # preview: identities, capabilities, harness rules
printf '%s' "$ADMIN_TOKEN" | graphyard master autonomy --admin-token-stdin --apply
```

## Two-party decisions

Every decision except the three human-only ones is a two-party decision on one work item.

1. The master requests it: `master decide GY-N ACTION [JSON|@FILE] REASON` (`POST /api/work/GY-N/decide`).
   - **Actions:** `release`, `unblock`, `requirements`, `resolve`, `attest`, `merge`, `rework`, `recover` and `grant`.
   - **Binding:** the CLI fills it from the item's current state.
   - **Refused unless:** the requester holds the action's capability and the item is still in the state it names.
   - **Limit:** one open decision per action at a time.
2. `master approver GY-N DECISION` launches a separate session as the approver identity, prompted to judge the reason against the item and the operator's goals.
3. `master approve GY-N DECISION REASON` applies it, after re-checking the requester's live authority and the item's state.
   - **The server refuses, naming the conflict, when the approver:** requested the decision, has held an assignment on the item, produced evidence it rests on, or is the principal a `grant` would empower.

## Harness rules per role

- **`master autonomy --apply`:** installs the master's harness rules, also denying a command pointed at another identity's credential file.
- **Dispatch:** installs each worker's rules in its assigned worktree.
- **Regeneration:** idempotent; existing entries are never removed.
- **Master may run:** its own CLI subcommands at their absolute path, `herdr`, `jq`, the audited-thread wrapper, plus [everything else it owns](master-agent.md#harness-permissions).
- **Allowed `gh`:** read-only `gh pr`, `gh api user`, `gh api` reads of the base branch's protection and `--method PATCH` writes to its subresources, `gh api user/installations` and `gh api apps/*` reads.
- **Files:** reads of `.graphyard/master-actions/` and writes to `.graphyard/profiles/`.
- **Denied `gh`:** `gh pr merge`, `gh pr review`, any `gh api` call that merges, posts a review, mints a token, uses GraphQL, `PUT`, `POST` or `DELETE`.
- **Also denied:** every direct `agent-browser` command, `git push`, reads of the coordinator credential home, `.graphyard/connection.json`, `*.pem` and `*.token`.

| Role | May | May not |
| --- | --- | --- |
| worker | push its assigned branch (`origin BRANCH`, `-u`, `HEAD:BRANCH`), run its item's Graphyard commands, open its pull request | force-push, push the base branch, rebase, merge, post a review, submit evidence |
| reviewer | read the diff and post the one verdict it was launched for | push, commit, claim, submit evidence, edit files |
| producer | fetch, add and remove its detached worktree, submit evidence | push, commit, claim, post a review |

## Other operator agents

- **Secret:** random, at least 32 characters, kept in a password manager.
- **File:** only non-secret configuration: `id`, `displayName`, `capabilities`, `scope`, `reason`. Prefer explicit work IDs over `"*"`.
- **Set up:** `printf '%s' "$SECRET" | graphyard operator-agent setup operator.json --token-stdin`, then `graphyard operator-agent list`.
- **Dashboard's Operator automation view:** redacted identity, fingerprint, capabilities, scopes, revision, revocation state and last mutation; plaintext secrets are never returned or stored.
- **`operator-agent configure ID FILE`:** changes scope, requiring `expectedRevision` and complete replacement lists.
- **`operator-agent rotate ID SECONDS REASON --token-stdin`:** issues a new credential with bounded overlap (zero for immediate cutover, at most 24 hours); verify the new fingerprint before it ends.
- **`operator-agent revoke ID REASON`:** immediate and fail-closed for every active or transitional credential; a revoked identity is retained for audit.
- **Never** answer a denial by weakening gates.

## Threat model

- **Stolen credential:** exercises only its configured capabilities and targets: revoke it and inspect the immutable events.
- **Every route:** checks authenticated role, capability, repository and work scope.
- **An agent:** cannot edit its own scope or credentials.
- **Startup:** fails closed when a repository-bound engine is paired with another repository's adapter.
- **Expected revisions:** reject stale policy edits.
- **No lease commands, no evidence authority:** a `manual:` attestation needs an approved `attest` decision.
- **[Conflicted approver](#two-party-decisions):** refused and recorded by the server.
- **Secrets:** travel on stdin; responses and events carry fingerprints only.
- **Revoking the identity:** returns coordination to the human operator.
