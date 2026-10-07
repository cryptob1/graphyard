<!-- page: Start here | 2 | terms, roles. -->
# Glossary

### 1. Human operator (human authority)

`admin` with `sessionKind: "human"`; alone decides goals, spending, accounts, people's credentials.

**Canonical usage:** *human operator*.

### 2. AI agent

A model in a runtime with only its credential's authority.

**Canonical usage:** name the role.

### 3. Agent session (Herdr-managed session or runtime)

One running agent instance.

**Canonical usage:** *session*; its host: *runtime*.

### 4. Principal, role, and credential

*Principal*: authenticated identity; *role*: authority class; *credential*: its secret.

**Canonical usage:** one principal per session.

### 5. Worker lease and worktree

*Lease*: a worker's timed hold on one item at one *epoch*; *assigned worktree*: its registered checkout.

**Canonical usage:** *lease*, *epoch*, *assigned worktree*.

### 6. Independent reviewer and proof producer

*Reviewer*: non-author GitHub identity approving the exact head; *proof producer*: `producer` granted named proofs.

**Canonical usage:** *reviewer*, *proof producer*.

### 7. Graphyard control plane

Server, database, dashboard, CLI.

**Canonical usage:** Graphyard *records*, *refuses*, *authorizes*; never *runs* sessions.

### 8. Herdr runtime

Launches sessions, reports liveness.

**Canonical usage:** *Herdr*; other runtimes by product name.

## The roles at a glance

Role | Held by | May
---|---|---
| `admin` | Human operator | Any decision; never shared with AI
| `operator-agent` | Master, approver | Add intent; request or approve decisions, never its own
| `coordinator` | Master loop | Dispatch, reconcile merges; never implement or prove
| `slice-lead` | Slice lead | Rule on its slice, escalate
| `worker` | Worker | Claim, heartbeat, register, submit
| `producer` | CI, runner, observer | Report granted proofs, never on its own work
| `reader` | Dashboards | Read

## Who decides

The master applies non-weakening intent directly; two-party decisions (`graphyard master decide GY-N ACTION REASON`, applied by a separate approver's `graphyard master approve GY-N DECISION REASON`) cover requirement rewrites, escalations, [high-lane](how-graphyard-works.md#risk-lanes) rework, recovery, `manual:` attestation, proof grants and triage closures; human-only decisions [park](master-agent-reference.md#items-scope-and-human-waits) items. `POST /api/work/:id/decide` resumes an approval left unapplied.

## Diagram legend

Amber: human operator; green: agent session; blue: control plane; violet: Herdr; grey: GitHub and external facts; dashed chip: credential, epoch or worktree; solid arrow: command; dashed arrow: observation.
