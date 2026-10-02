<!-- page: Start here | 2 | terms, roles, who decides. -->
# Glossary

### 1. Human operator (human authority)

The `admin` holder (`sessionKind: "human"`); alone decides goals, priorities, spending, accounts and people's credentials.

**Canonical usage:** *human operator*; bare *operator* means them.

### 2. AI agent

A model acting through a runtime with its credential's authority only.

**Canonical usage:** the role's name.

### 3. Agent session (Herdr-managed session or runtime)

One agent instance running in a runtime.

**Canonical usage:** *session*; *runtime* hosts it.

### 4. Principal, role, and credential

*Principal*: authenticated identity; *role*: its authority class; *credential* (*token*): its secret.

**Canonical usage:** one principal per session.

### 5. Worker lease and worktree

*Lease*: a worker's timed hold on one item at one *epoch*; *assigned worktree*: its registered `(host, path)` checkout.

**Canonical usage:** *lease*, *epoch*, *assigned worktree*.

### 6. Independent reviewer and proof producer

*Reviewer*: a non-author GitHub identity approving the exact head; *proof producer*: a `producer` principal granted exact proofs. Neither implements.

**Canonical usage:** *reviewer*, *proof producer*.

### 7. Graphyard control plane

Server, database, dashboard, CLI.

**Canonical usage:** Graphyard *records*, *refuses*, *authorizes*; never *runs* a session.

### 8. Herdr runtime

Launches sessions, reports liveness.

**Canonical usage:** *Herdr*; others by product name.

## The roles at a glance

| Role | Held by | May | Never
|---|---|---|---
| `admin` | Human operator | Any decision | Share with AI
| `operator-agent` | Master and approver | Add intent; request, approve decisions | Approve its own request; merge
| `coordinator` | Master loop | Dispatch, guarded merge | Implement, produce evidence
| `slice-lead` | Slice lead | Rule on its slice, escalate | Implement, merge
| `worker` | Worker | Claim, heartbeat, register, submit | Satisfy acceptance
| `producer` | CI, runner, observer | Report granted proofs | Prove its own work
| `reader` | Dashboards | Read | Mutate

## Who decides

The master applies non-weakening intent (create, release, unblock, add requirements). Two-party decisions (`master decide GY-N ACTION REASON`, applied by another approver's `master approve GY-N DECISION REASON`) cover requirement rewrites, escalations, [high-lane](how-graphyard-works.md#risk-lanes) rework, recovery, `manual:` attestation, proof grants, repair-lane merges, triage closures, and merges with automatic merging off. The approver is never the requester, assignee, producer or grantee. Reviewers, producers and the merge gate decide the rest; human-only decisions [park](master-agent-reference.md#items-scope-and-human-waits) the item.

## Diagram legend

Amber: human operator; green: agent session (one role, one credential); blue: control plane; violet: Herdr; grey: GitHub and external facts; dashed chip: credential, epoch or worktree; solid arrow: authenticated command; dashed arrow: observation, never authority.
