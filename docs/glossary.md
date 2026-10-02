<!-- page: Start here | 2 | terms, roles, who decides. -->
# Glossary

### 1. Human operator (human authority)

`admin` with `sessionKind: "human"`; alone decides goals, priorities, spending, accounts, people's credentials.

**Canonical usage:** *human operator*; bare *operator* = this person.

### 2. AI agent

A model in a runtime with only its credential's authority.

**Canonical usage:** name the role (*worker*, *master*, *approver*…).

### 3. Agent session (Herdr-managed session or runtime)

One running agent instance.

**Canonical usage:** *session*; hosting software: *runtime*.

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

The master directly applies non-weakening intent (create, release, unblock, add requirements). `graphyard master decide GY-N ACTION REASON`, applied by a separate approver's `graphyard master approve GY-N DECISION REASON`: requirement rewrites, escalations, [high-lane](how-graphyard-works.md#risk-lanes) rework (low/medium apply as requested), recovery, `manual:` attestation, proof grants, repair-lane merges, triage closures, merges with automatic merging off. Approver ≠ requester, assignee, evidence producer, grantee. Reviewers, producers, merge gate decide the rest; human-only decisions [park](master-agent-reference.md#items-scope-and-human-waits) items.

## Diagram legend

Shape and colour | Term
---|---
Amber rounded box | Human operator
Green rounded box | Agent session (one role, credential)
Blue square box | Graphyard control plane
Violet box | Herdr runtime
Grey square box | GitHub, external facts
Dashed chip | Credential, lease epoch or worktree
Solid arrow | Authenticated command
Dashed arrow | Observation, never authority
