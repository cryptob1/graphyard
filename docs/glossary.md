<!-- page: Start here | 2 | one definition per term, who decides, diagram legend. -->
# Glossary

One definition and one canonical usage per term.

## The eight distinctions

### 1. Human operator (human authority)

The person administering the installation with an `admin` credential declaring `sessionKind: "human"`. They keep three decisions: **goals and priorities**, **spending money or opening third-party accounts**, and **issuing credentials to people**. Every other decision is made by one agent role and approved by an independent one ([Who decides](#who-decides)).

**Canonical usage:** *human operator*; bare *operator* means this person, never the operator agent.

### 2. AI agent

A language-model program acting through a runtime; its authority is only its credential.

**Canonical usage:** name the role (*worker*, *master*, *approver*, *slice lead*, *reviewer*, *proof producer*, *operator agent*) unless it does not matter.

### 3. Agent session (Herdr-managed session or runtime)

One running agent instance in a runtime. A dashboard sign-in is not a session; `sessionKind` is a credential declaration.

**Canonical usage:** *session*; *runtime* for the hosting software.

### 4. Principal, role, and credential

A *principal* is an authenticated identity, its *role* the authority class, its *credential* (*token*) the secret. Everything is attributed to the principal.

**Canonical usage:** one principal per concurrent session.

### 5. Worker lease and worktree

A *lease* is time-limited ownership of one item by one worker at one *epoch*; `complete`, release or expiry end it. The *assigned worktree* is the registered `(host, path)` checkout with a reserved branch.

**Canonical usage:** *lease*, *epoch*, *assigned worktree*.

### 6. Independent reviewer and proof producer

A *reviewer* is a GitHub identity, not the PR author or the control-plane App, approving the exact head. A *proof producer* is a `producer` principal whose live grant authorizes exact proof names. Neither ever implements the item.

**Canonical usage:** *reviewer*, *proof producer*; never *the tester*.

### 7. Graphyard control plane

The server, Postgres, dashboard and CLI that record and gate delivery. It has no lifecycle-state endpoint and no merge bypass, and runs no agents.

**Canonical usage:** Graphyard *records*, *evaluates*, *refuses*, *authorizes*; it never *runs* a session.

### 8. Herdr runtime

The supervisor that launches and stops sessions and reports whether they are alive. It never decides ownership or progression.

**Canonical usage:** *Herdr*; other runtimes by product name.

## The roles at a glance

| Role | Held by | May | Never |
| --- | --- | --- | --- |
| `admin` | Human operator | Goals, provision agent identities, any decision directly | Share with an AI session; mint automated evidence |
| `operator-agent` | Master identity; approver identity | Master: create, release, unblock, add requirements, request decisions. Approver: approve others' decisions | Approve its own request; hold a lease; merge |
| `coordinator` | Master loop | Dispatch, guarded merge, deployment observations, settle a verified-dead quarantine | Implement, produce evidence |
| `slice-lead` | Slice lead | Rule on its slice, escalate | Implement, merge |
| `worker` | Worker | Claim, heartbeat, register, submit | Satisfy an acceptance gate |
| `producer` | CI, trusted runner, observer | Trusted evidence for granted proofs | Prove an item it worked on |
| `reader` | Dashboards | Read | Mutate |

## Who decides

The master requests with `graphyard master decide GY-N ACTION REASON`; a separate approver applies with `graphyard master approve GY-N DECISION REASON`. The server refuses an approver that requested the decision, held an assignment on the item, produced its evidence, or would receive the grant.

| Decision | Made by | Approved by |
| --- | --- | --- |
| Create, release, unblock, add requirements | Master | Applied directly (non-weakening) |
| Rewrite or remove requirements; resolve an escalation; rework or recover | Master (`decide`) | Approver |
| Attest a `manual:` proof; grant proof authority; merge with automatic merging off | Master (`decide`) | Approver independent of that evidence or grant |
| Approve a candidate | Reviewer | Branch protection and merge gate |
| Produce trusted evidence | Proof producer | Acceptance gate |
| Merge | Master | Merge gate on the exact candidate |
| Goals; money or accounts; credentials for people | **Human operator** | — |

An item needing a human decision is parked (`graphyard park`) until the human answers (`graphyard answer` or **Work → Needs you**).

## Diagram legend

| Shape and colour | Term |
| --- | --- |
| Amber rounded box | Human operator |
| Green rounded box | Agent session with one role and credential |
| Blue square box | Graphyard control plane |
| Violet box or container | Herdr runtime |
| Grey square box | GitHub and other external facts |
| Dashed chip | Credential, lease epoch, or worktree |
| Solid arrow | Authenticated command |
| Dashed arrow | Observation, never authority |
