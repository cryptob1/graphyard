<!-- page: Start here | 2 | terms, roles, who decides. -->
# Glossary

### 1. Human operator (human authority)

The `admin` credential holder declaring `sessionKind: "human"`; alone decides goals, priorities, spending, new accounts and people's credentials.

**Canonical usage:** *human operator*; bare *operator* means this person.

### 2. AI agent

A model acting through a runtime with only its credential's authority.

**Canonical usage:** name the role.

### 3. Agent session (Herdr-managed session or runtime)

One running agent instance in a runtime.

**Canonical usage:** *session*; *runtime* for the hosting software.

### 4. Principal, role, and credential

*Principal*: an authenticated identity; *role*: its authority class; *credential* (*token*): its secret.

**Canonical usage:** one principal per concurrent session.

### 5. Worker lease and worktree

*Lease*: a worker's timed hold on one item at one *epoch*; *assigned worktree*: its registered `(host, path)` checkout and reserved branch.

**Canonical usage:** *lease*, *epoch*, *assigned worktree*.

### 6. Independent reviewer and proof producer

A *reviewer*: a non-author GitHub identity approving the exact head; a *proof producer*: a `producer` principal granted exact proof names. Neither implements.

**Canonical usage:** *reviewer*, *proof producer*.

### 7. Graphyard control plane

Server, database, dashboard and CLI.

**Canonical usage:** Graphyard *records*, *refuses*, *authorizes*; it never *runs* a session.

### 8. Herdr runtime

Launches sessions and reports liveness.

**Canonical usage:** *Herdr*; other runtimes by product name.

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

The master applies non-weakening intent (create, release, unblock, add requirements) directly. Two-party decisions (`master decide GY-N ACTION REASON`, applied by a separate approver's `master approve GY-N DECISION REASON`) cover requirement rewrites, escalations, [high-lane](how-graphyard-works.md#risk-lanes) rework, recovery, `manual:` attestation, proof grants, repair-lane merges, triage closures, and merges with automatic merging off. An approver may not be the requester, an assignee, the evidence producer or the grantee. Reviewers, producers and the merge gate decide the rest; a human-only decision [parks](master-agent-reference.md#items-scope-and-human-waits) the item until answered.

## Diagram legend

Amber rounded box: human operator; green rounded box: agent session (one role, one credential); blue square box: Graphyard control plane; violet box: Herdr runtime; grey square box: GitHub and external facts; dashed chip: credential, lease epoch or worktree; solid arrow: authenticated command; dashed arrow: observation, never authority.
