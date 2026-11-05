<!-- page: Start here | 2 | terms -->
# Glossary

### 1. Human operator (human authority)

`admin` with `sessionKind: "human"`. Keeps goals and priorities, money and accounts, and credentials for people; answers physical `human:` checks.

### 2. AI agent

An AI using only its principal's authority. Name the role.

### 3. Agent session (Herdr-managed session or runtime)

A running agent instance. Its host is the runtime.

### 4. Principal, role, and credential

*Principal*: identity; *role*: authority; *credential*: secret. One principal per concurrent session. Item `owner`: human principal; worker lease: execution ownership. Now: signed-in person’s items.

### 5. Worker lease and worktree

*Lease*: worker's timed hold on one item at one *epoch*; *assigned worktree*: registered `(host, path)` checkout.

### 6. Independent reviewer and proof producer

*Reviewer*: non-author identity approving exact head; *proof producer*: `producer` whose roster entry names proofs. Neither implements.

### 7. Graphyard control plane

Server, database, dashboard and CLI. Owns leases/history/gates independently of Herdr. The AI master decides; the loop program observes and acts.

### 8. Herdr runtime

Launches sessions, reports liveness.

## The roles at a glance

Role | Held by | May | Never
---|---|---|---
| `admin` | Human operator | Any decision | Share with AI
| `operator-agent` | Master | Apply decisions | Merge
| `coordinator` | Loop and master coordination | Dispatch, reconcile merges | Implement, prove
| `slice-lead` | Slice lead | Rule, hold | Implement, merge
| `worker` | Worker | Claim, heartbeat, register, submit | Satisfy acceptance
| `producer` | CI, runner, observer | Report roster proofs | Prove own work
| `reader` | Dashboards | Read | Mutate

## Who decides

The master applies release, unblock, requirements, rework, close and attest under its operator-agent identity. Routine actions need no human approval. Only the three human decisions [park](master-agent-reference.md#items-and-human-waits).

## Plain stage labels

The dashboard and `master status` show these labels. Graphyard derives the underlying stages from gates; no client sets them.

Not started (backlog, ready) — nobody holds it yet.
Waiting (build) — no worker holds it and no session runs; master status names why when the reason is known (GY-3095).
Building (build) — a worker holds it and is writing the change.
Testing (test, acceptance) — automated checks or proofs are running on the handed-in change.
In review (review) — someone other than the builder is judging the change.
Merging (merge) — the merge writer is queuing or trying the change onto main.
Merged, not live yet (done) — merged; the app has not been seen serving it.
Live (done) — the app serves it; no verdict names this item.
Live and verified (done) — its own merge is served and the required cases passed (GY-2983).
Live and failing (done) — served, and a failing required case is its own merge's or proves it (GY-2983).
Done (done) — closed, or merged where the repository has no deployment.

## Diagram legend

Shape and colour | Term
---|---
Amber rounded box | Human operator
Green rounded box | Agent session
Blue square box | Control plane
Violet box | Herdr runtime
Grey square box | Git remote
Dashed chip | Credential, epoch or worktree
Solid arrow | Command
Dashed arrow | Observation
