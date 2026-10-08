<!-- page: Start here | 2 | terms, roles. -->
# Glossary

### 1. Human operator (human authority)

`admin` with `sessionKind: "human"`; alone decides goals, priorities, spending, accounts, people's credentials. **Canonical usage:** *human operator*; bare *operator* = this person.

### 2. AI agent

Model holding only its credential's authority. **Canonical usage:** name role.

### 3. Agent session (Herdr-managed session or runtime)

Running agent instance. **Canonical usage:** *session*; host: *runtime*.

### 4. Principal, role, and credential

*Principal*: authenticated identity; *role*: authority class; *credential* (*token*): secret. **Canonical usage:** one principal per concurrent session.

### 5. Worker lease and worktree

*Lease*: worker's timed hold on one item at one *epoch*; *assigned worktree*: registered `(host, path)` checkout, reserved branch. **Canonical usage:** *lease*, *epoch*, *assigned worktree*.

### 6. Independent reviewer and proof producer

*Reviewer*: non-author GitHub identity approving exact head; *proof producer*: `producer` granted named proofs. Neither implements. **Canonical usage:** *reviewer*, *proof producer*.

### 7. Graphyard control plane

Server, database, dashboard, CLI. **Canonical usage:** Graphyard *records*, *refuses*, *authorizes*, never *runs* sessions.

### 8. Herdr runtime

Launches sessions, reports liveness. **Canonical usage:** *Herdr*; other runtimes by product name.

## The roles at a glance

Role | Held by | May | Never
---|---|---|---
| `admin` | Human operator | Any decision | Share with AI
| `operator-agent` | Master, approver | Add intent; request, approve | Self-approve; merge
| `coordinator` | Master loop | Dispatch, reconcile merges | Implement, prove
| `slice-lead` | Slice lead | Rule, escalate | Implement, merge
| `worker` | Worker | Claim, heartbeat, register, submit | Satisfy acceptance
| `producer` | CI, runner, observer | Report granted proofs | Prove own work
| `reader` | Dashboards | Read | Mutate

## Who decides

Master applies non-weakening intent directly; two-party decisions (`master decide GY-N ACTION REASON`, another's `master approve GY-N DECISION REASON`) cover requirement rewrites, escalations, [high-lane](how-graphyard-works.md#risk-lanes) rework the record doesn't ground, recovery, `manual:` attestation, proof grants, triage closures, merges with auto-merge off; gates decide the rest; human-only decisions [park](master-agent-reference.md#items-scope-and-human-waits) items.

An approved-but-unapplied decision never blocks the action's next request: bound to a passed head and base it settles `superseded`; otherwise it resumes after 60s (risk-lane rework at once), and once its approver session ends the next cycle sends `POST /api/work/:id/decide` `{"action":"resume","decision":ID}`. `master status` shows `approved but unapplied since <approvedAt>` (`loop-silence` fault).

A revision-bound decision (release, unblock, close, unpinned resolve) applies past lease renewals, liveness and observation, settling `stale` on any other item change; an approved close ends only the lease it judged. The loop re-validates a stale close and re-requests it at the current revision, taking no other decision on it meanwhile; stale settles form one `wait:decision-stale:<id>:close` action; after three in a row the loop stops, `master status` raising `Decision GY-N/ACTION (ACTION) is stale`.

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
