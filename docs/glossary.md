<!-- page: Start here | 2 | terms -->
# Glossary

### 1. Human operator (human authority)

`admin` with `sessionKind: "human"`; alone decides goals, priorities, spending, credentials. **Canonical usage:** *human operator*.

### 2. AI agent

Model holding only its credential's authority. **Canonical usage:** name the role.

### 3. Agent session (Herdr-managed session or runtime)

A running agent instance. **Canonical usage:** *session*; host: *runtime*.

### 4. Principal, role, and credential

*Principal*: identity; *role*: authority class; *credential*: secret. **Canonical usage:** one principal per concurrent session.

### 5. Worker lease and worktree

*Lease*: worker's timed hold on one item at one *epoch*; *assigned worktree*: registered `(host, path)` checkout. **Canonical usage:** *lease*, *epoch*, *assigned worktree*.

### 6. Independent reviewer and proof producer

*Reviewer*: non-author identity approving exact head; *proof producer*: `producer` whose roster entry names proofs. Neither implements. **Canonical usage:** *reviewer*, *proof producer*.

### 7. Graphyard control plane

Server, database, dashboard, CLI. **Canonical usage:** Graphyard *records* and *refuses*, never *runs* sessions.

### 8. Herdr runtime

Launches sessions, reports liveness. **Canonical usage:** *Herdr*; others by product name.

## The roles at a glance

Role | Held by | May | Never
---|---|---|---
| `admin` | Human operator | Any decision | Share with AI
| `operator-agent` | Master | Apply decisions | Merge
| `coordinator` | Master loop | Dispatch, reconcile merges | Implement, prove
| `slice-lead` | Slice lead | Rule, hold | Implement, merge
| `worker` | Worker | Claim, heartbeat, register, submit | Satisfy acceptance
| `producer` | CI, runner, observer | Report roster proofs | Prove own work
| `reader` | Dashboards | Read | Mutate

## Who decides

Master applies `release`, `unblock`, `requirements`, `rework`, `close` and `attest` at once under its operator-agent identity. Human keeps goals and priorities, money and accounts, credentials for people; those [park](master-agent-reference.md#items-and-human-waits).

## Plain stage labels

Where an open or delivered item is, in the words the dashboard and `master status` show (GY-2988). The control plane still derives backlog, ready, build, review, test, acceptance, merge and done; only the label people read changes, and no client sets it.

Building (build) — a worker is writing the change, or it is waiting for one.
Testing (test) — automated checks or proofs are running on the handed-in change.
In review (review) — someone other than the builder is judging the change.
Merging (merge) — the merge writer is queuing or trying the change onto main.
Live and verified — merged and served; the served commit's required cases passed (GY-2983).
Live and failing — merged and served; a required case against the served URL is failing (GY-2983).
Live — merged; the repository serves nothing, so there is no verification verdict.
Done — merged (or closed) and not live on a served head.

## Diagram legend

Shape and colour | Term
---|---
Amber rounded box | Human operator
Green rounded box | Agent session
Blue square box | Control plane
Violet box | Herdr runtime
Grey square box | GitHub
Dashed chip | Credential, epoch or worktree
Solid arrow | Command
Dashed arrow | Observation
