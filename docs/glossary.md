<!-- page: Start here | 2 | human operator, agent session, principal, lease, reviewer, proof producer, control plane, runtime: one definition each, plus the diagram legend. -->
# Glossary

One definition and one canonical usage per term. Every guide uses these words in these senses.

## The eight distinctions

### 1. Human operator (human authority)

The person who administers the installation, holding an `admin` credential with `sessionKind: "human"`. They keep exactly three decisions: **goals and priorities**, **spending money or opening third-party accounts**, and **issuing credentials to people**. Every other decision is made by one agent role and approved by an independent one ([Who decides](#who-decides)); the control plane refuses an approver that is the requester, held an assignment on the item, produced its evidence, or would be empowered by the grant.

**Canonical usage:** *human operator*. Bare *operator* always means this person. Never write *operator* for the scoped operator agent.

### 2. AI agent

A language-model program acting through an agent runtime. Its authority comes only from the credential it holds.

**Canonical usage:** *agent* only when the role does not matter; otherwise *worker*, *master*, *approver*, *slice lead*, *reviewer*, *proof producer*, *operator agent*.

### 3. Agent session (Herdr-managed session or runtime)

One running instance of an agent in a runtime (a Herdr tab, a Claude Code, Codex, Cursor or opencode process). A dashboard sign-in is not a session; `sessionKind` is a declaration on a credential, not a session.

**Canonical usage:** *agent session* or *session*; *runtime* for the hosting software.

### 4. Principal, role, and credential

A *principal* is an authenticated identity (an `id` in `GRAPHYARD_PRINCIPALS` or the operator-agent registry); its *role* is its authority class; its *credential* (*token*) is the secret. Everything is attributed to the principal.

**Canonical usage:** *principal*, *role*, *token* or *credential*. One principal per concurrent session.

### 5. Worker lease and worktree

A *lease* is time-limited ownership of one item by one worker at one *epoch*. Heartbeats renew it; `complete`, release or expiry end it; every claim raises the epoch. The *assigned worktree* is the Git checkout registered as the assignment's workspace `(host, path)` with a reserved branch.

**Canonical usage:** *lease*, *epoch*, *assigned worktree*.

### 6. Independent reviewer and proof producer

A *reviewer* is a GitHub identity, neither the PR author nor the control-plane App, that approves the exact head; it holds no Graphyard credential. A *proof producer* is a `producer` principal whose live grant authorizes exact proof names; its evidence binds head SHA, base SHA and policy revision. Neither is ever an implementer of the item.

**Canonical usage:** *reviewer*, *proof producer*. Never *the tester*.

### 7. Graphyard control plane

The server, Postgres database, dashboard and CLI that record ownership, requirements, candidates, evidence, gates and merge authorization. Gates are deterministic. There is no lifecycle-state endpoint and no merge bypass. It runs no agents.

**Canonical usage:** *Graphyard* or *the control plane*; it *records*, *evaluates*, *refuses* and *authorizes*, never *runs* a session.

### 8. Herdr runtime

The session supervisor that launches, shows and stops sessions and reports whether they are alive. It never decides ownership, evidence or progression.

**Canonical usage:** *Herdr*; other runtimes by product name, or *agent runtimes*.

## The roles at a glance

| Role (credential) | Normally held by | May | Never |
| --- | --- | --- | --- |
| `admin` | Human operator | Set goals, provision agent identities (`master autonomy`), issue credentials to people, make any decision directly | Mint trusted automated evidence; be shared with an AI session |
| `operator-agent` | The master's identity and the separate approver identity | Master: create, release, unblock, add requirements, request decisions. Approver: approve decisions it did not request | Approve its own request; hold a lease; merge |
| `coordinator` | Master loop | Read work and runtime health, dispatch, guarded merge, record deployment observations, settle a verified-dead quarantine | Claim, implement, produce evidence, bypass a gate |
| `slice-lead` | Slice lead | Rule on plans and failures in its slice, escalate | Implement, hold a lease, submit evidence, merge |
| `worker` | Worker | Claim, heartbeat, register its worktree, submit, record untrusted assertions | Hold other credentials; satisfy an acceptance gate |
| `producer` | CI workflow, trusted runner, deployment observer | Submit trusted evidence for granted proofs | Hold an assignment on the item it proves |
| `reader` | Dashboards | Read | Mutate anything |

## Who decides

The master requests two-party decisions with `graphyard master decide GY-N ACTION REASON`; the approver applies them with `graphyard master approve GY-N DECISION REASON`.

| Decision | Made by | Approved by |
| --- | --- | --- |
| Create, release, unblock, add requirements | Master (operator-agent) | Applied directly (non-weakening); gates judge what follows |
| Rewrite, remove or narrow requirements (`decide … requirements`) | Master | Approver; still raises `requirement-weakening` |
| Resolve an escalation (`decide … resolve`) | Master | Approver |
| Attest a `manual:` proof (`decide … attest`) | Master | Approver that produced no evidence for it |
| Rework or containment recovery (`decide … rework`, `decide … recover`) | Master | Approver |
| Grant proof authority (`decide … grant`) | Master | Approver that is not the grantee |
| Merge when automatic merging is off (`decide … merge`) | Master | Approver that produced no evidence on the item |
| Approve a candidate | Reviewer | Branch protection and the merge gate |
| Produce trusted evidence | Proof producer | The acceptance gate |
| Merge | Master (guarded merge) | The merge gate on the exact candidate |
| Goals and priorities; spending or third-party accounts; credentials for people | **Human operator** | — |

An item that needs one of the three human decisions records a *human-only request* (`graphyard park`); the human answers with `graphyard answer` or **Work → Needs you**, and the loop dispatches it again.

## Diagram legend

| Shape and colour | Glossary term |
| --- | --- |
| Amber rounded box | Human operator |
| Green rounded box | AI agent session holding one role and credential |
| Blue square-cornered box | Graphyard control plane |
| Violet rounded box or container | Herdr runtime |
| Grey square-cornered box | GitHub and other external facts |
| Dashed chip inside a box | A credential, lease epoch, or assigned worktree |
| Solid arrow | An authenticated command or authority |
| Dashed arrow | An observation, never authority |
