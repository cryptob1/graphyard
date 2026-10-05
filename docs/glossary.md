<!-- page: Start here | 2 | terms, roles, who decides. -->
# Glossary

### 1. Human operator (human authority)

`admin` with `sessionKind: "human"`; alone decides goals, priorities, spending, accounts, people's credentials.

**Canonical usage:** *human operator*; bare *operator* = this person.

### 2. AI agent

A model in a runtime, holding only its credential's authority.

**Canonical usage:** name the role (*worker*, *master*, *approver*…).

### 3. Agent session (Herdr-managed session or runtime)

One running agent instance.

**Canonical usage:** *session*; its host: *runtime*.

### 4. Principal, role, and credential

*Principal*: authenticated identity; *role*: authority class; *credential* (*token*): secret.

**Canonical usage:** one principal per concurrent session.

### 5. Worker lease and worktree

*Lease*: worker's timed hold on one item at one *epoch*; *assigned worktree*: registered `(host, path)` checkout, reserved branch.

**Canonical usage:** *lease*, *epoch*, *assigned worktree*.

### 6. Independent reviewer and proof producer

*Reviewer*: non-author GitHub identity approving the exact head; *proof producer*: `producer` granted exact proof names. Neither implements.

**Canonical usage:** *reviewer*, *proof producer*.

### 7. Graphyard control plane

Server, database, dashboard, CLI.

**Canonical usage:** Graphyard *records*, *refuses*, *authorizes*, never *runs* sessions.

### 8. Herdr runtime

Launches sessions, reports liveness.

**Canonical usage:** *Herdr*; other runtimes by product name.

## The roles at a glance

Role | Held by | May | Never
---|---|---|---
| `admin` | Human operator | Any decision | Share with AI
| `operator-agent` | Master, approver | Add intent; request/approve decisions | Approve own request; merge
| `coordinator` | Master loop | Dispatch, guarded merge | Implement, produce evidence
| `slice-lead` | Slice lead | Rule on slice, escalate | Implement, merge
| `worker` | Worker | Claim, heartbeat, register, submit | Satisfy acceptance
| `producer` | CI, runner, observer | Report granted proofs | Prove its own work
| `reader` | Dashboards | Read | Mutate

## Who decides

The master applies non-weakening intent directly. Two-party decisions (`graphyard master decide GY-N ACTION REASON`, applied by a separate approver's `graphyard master approve GY-N DECISION REASON`) cover requirement rewrites, escalations, [high-lane](how-graphyard-works.md#risk-lanes) rework, recovery, `manual:` attestation, proof grants, triage closures and merges with automatic merging off. Gates decide the rest; human-only decisions [park](master-agent-reference.md#items-scope-and-human-waits) items.

## Diagram legend

Amber rounded box: human operator; green rounded box: agent session (one role, credential); blue square box: Graphyard control plane; violet box: Herdr runtime; grey square box: GitHub, external facts; dashed chip: credential, lease epoch or worktree; solid arrow: authenticated command; dashed arrow: observation, never authority.
