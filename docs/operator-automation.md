<!-- page: Operate Graphyard | 10 | least-privilege agents. -->
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
- `decision:approve`: Approve another identity's decision, under the [conflict rules](#two-party-decisions)

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
3. `master approve GY-N DECISION REASON` applies it, after re-checking the requester's live authority and the item's state.

## Escalation context

A master carrying the rules, an item's history and earlier decisions in its own window hits a context ceiling and drifts between sessions, so the control plane assembles that context from the project instead: a handler spawned for one escalation decides as well as a long-lived master. `GET /api/work/GY-N/context?trigger=TRIGGER&budget=BYTES`, printed by `master context GY-N [TRIGGER] [--budget N]`, returns four layers, read by key alone and verified against its fingerprint:

- **`rules`:** the managed repository's own `AGENTS.md` at the base tip the item was last observed against, read through the control-plane App (`rules.source`), plus the item's policy — never a template, so an installation escalates against the codebase it manages; without the file, `rules.unavailable`
- **`goals`:** priority, the reasons recorded with the item's `create`, `ready`, `requirements` and `unblock` intents, the open graph in priority order, dependencies and dependents
- **`precedent`:** every `resolve` decision across the graph with requester, reason, approver, outcome and the precedent it cited — this trigger first, the rest counted

Assembly is deterministic and bounded: one snapshot, canonical bytes, `fingerprint` the SHA-256 of the rest, so a handler can prove what it saw. `GRAPHYARD_ESCALATION_CONTEXT_BUDGET` (default 32,000) or the request's `budget` is met by summarising — `budget.level`, `history.omitted`, `precedent.omitted`, `precedent.summary` — never by shortening `rules`; `budget.exceeded` says so rather than cut.

A handler decides with `master decide GY-N resolve '{"trigger":"…"}' --precedent ID[,ID] --context FINGERPRINT REASON`, both carried into the ledger and shown by `master decisions GY-N`: a cited id that is no decision of the same action is refused, and a second handler on the same line is a `concurrences` entry, not a competing request. `master escalation GY-N [TRIGGER] [--budget N] [precedent|KIND]` spawns one — `precedent`, the default, follows the newest applied decision of that trigger in this process and declines when there is none; an agent `KIND` launches a judging session under `GRAPHYARD_ESCALATION_HANDLER=1` whose whole input is the context in one private file under `.graphyard/escalations/`, delivered as [its own first request](executors.md#the-request-is-the-sessions-first-message).

## Harness rules per role

- **`master autonomy --apply`:** installs the master's harness rules, also denying a command pointed at another identity's credential file.
- **Dispatch:** installs each worker's rules in its assigned worktree.
- **Regeneration:** idempotent; existing entries are never removed.
- **Master may run:** its own CLI subcommands at their absolute path, `herdr`, `jq`, the audited-thread wrapper, plus [everything else it owns](master-agent.md#harness-permissions).
- **Files:** reads of `.graphyard/master-actions/` and writes to `.graphyard/profiles/`.
- **Also denied:** every direct `agent-browser` command, `git push`, reads of the coordinator credential home, `.graphyard/connection.json`, `*.pem` and `*.token`.


## Other operator agents

- **Secret:** random, at least 32 characters, kept in a password manager.
- **File:** only non-secret configuration: `id`, `displayName`, `capabilities`, `scope`, `reason`. Prefer explicit work IDs over `"*"`.
- **Set up:** `printf '%s' "$SECRET" | graphyard operator-agent setup operator.json --token-stdin`, then `graphyard operator-agent list`.
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
