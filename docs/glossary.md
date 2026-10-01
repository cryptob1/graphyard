<!-- page: Start here | 2 | terms, roles. -->
# Glossary

## The eight distinctions

### 1. Human operator (human authority)

The `admin` credential holder declaring `sessionKind: "human"`; alone decides goals and priorities, spending or opening accounts, and credentials for people.

**Canonical usage:** *human operator*, or bare *operator*.

### 2. AI agent

A model acting through a runtime with only its credential's authority.

**Canonical usage:** its role (*worker*, *master*, *approver*, *reviewer*, *proof producer*).

### 3. Agent session (Herdr-managed session or runtime)

One running agent instance.

**Canonical usage:** *session*; *runtime* for its host software.

### 4. Principal, role, and credential

*Principal*: an authenticated identity; *role*: its authority class; *credential* (*token*): its secret.

**Canonical usage:** one principal per concurrent session.

### 5. Worker lease and worktree

*Lease*: one worker's time-limited ownership of one item at one *epoch*; *assigned worktree*: its registered `(host, path)` checkout with a reserved branch.

**Canonical usage:** the italic terms.

### 6. Independent reviewer and proof producer

*Reviewer*: a non-author GitHub identity approving the exact head; *proof producer*: a `producer` principal granted exact proof names. Neither implements.

**Canonical usage:** the italic terms.

### 7. Graphyard control plane

Server, database, dashboard and CLI.

**Canonical usage:** Graphyard *records*, *refuses*, *authorizes*; never *runs* a session.

### 8. Herdr runtime

The supervisor launching sessions and reporting liveness.

**Canonical usage:** *Herdr*; other runtimes by product name.

## The roles at a glance

| Role | Held by | May | Never |
| --- | --- | --- | --- |
| `admin` | Human operator | Any decision | Share it with AI |
| `operator-agent` | Master, approver | Add intent; request or approve decisions | Approve own request; merge |
| `coordinator` | Master loop | Dispatch, guarded merge | Implement, produce evidence |
| `slice-lead` | Slice lead | Rule on its slice, escalate | Implement, merge |
| `worker` | Worker | Claim, heartbeat, register, submit | Satisfy an acceptance gate |
| `producer` | CI, runner, observer | Evidence for granted proofs | Prove own work |
| `reader` | Dashboards | Read | Mutate |

## Who decides

The master applies non-weakening intent (create, release, unblock, add requirements) itself. Requirement rewrites, escalation resolution, rework, recovery, `manual:` attestation, proof grants, repair-lane merges, triage closures and merges with automatic merging off need `graphyard master decide GY-N ACTION REASON` approved by another agent's `graphyard master approve GY-N DECISION REASON`; the server refuses an approver that requested it, was assigned the item, produced its evidence or would get the grant. Reviewers, producers and the merge gate decide the rest; a human-only decision [parks](master-agent-reference.md#items-scope-and-human-waits) the item until answered.

## Diagram legend

Boxes: amber rounded, human operator; green rounded, single-role session; blue square, control plane; violet (or container), Herdr; grey square, GitHub and external facts. Dashed chips: credential, lease epoch, worktree. Arrows: solid, authenticated command; dashed, observation, never authority.
