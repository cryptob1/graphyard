<!-- page: Start here | 2 | terms, roles and who decides. -->
# Glossary

## The eight distinctions

### 1. Human operator (human authority)

The person holding an `admin` credential declaring `sessionKind: "human"`, who alone decides goals and priorities, spending money or opening accounts, and credentials for people.

**Canonical usage:** *human operator*; bare *operator* means this person.

### 2. AI agent

A model acting through a runtime, with only its credential's authority.

**Canonical usage:** name the role (*worker*, *master*, *approver*, *reviewer*, *proof producer*).

### 3. Agent session (Herdr-managed session or runtime)

One running agent instance in a runtime.

**Canonical usage:** *session*; *runtime* for the hosting software.

### 4. Principal, role, and credential

A *principal* is an authenticated identity, its *role* the authority class, its *credential* (*token*) the secret.

**Canonical usage:** one principal per concurrent session.

### 5. Worker lease and worktree

A *lease* is one worker's time-limited ownership of one item at one *epoch*. The *assigned worktree* is the registered `(host, path)` checkout with a reserved branch.

**Canonical usage:** *lease*, *epoch*, *assigned worktree*.

### 6. Independent reviewer and proof producer

A *reviewer* is a non-author GitHub identity approving the exact head; a *proof producer* is a `producer` principal granted exact proof names. Neither implements the item.

**Canonical usage:** *reviewer*, *proof producer*.

### 7. Graphyard control plane

The server, database, dashboard and CLI.

**Canonical usage:** Graphyard *records*, *refuses*, *authorizes*; it never *runs* a session.

### 8. Herdr runtime

The supervisor that launches sessions and reports whether they are alive.

**Canonical usage:** *Herdr*; other runtimes by product name.

## The roles at a glance

| Role | Held by | May | Never |
| --- | --- | --- | --- |
| `admin` | Human operator | Any decision | Share with an AI session |
| `operator-agent` | Master and approver | Add intent; request or approve decisions | Approve its own request; merge |
| `coordinator` | Master loop | Dispatch, guarded merge | Implement, produce evidence |
| `slice-lead` | Slice lead | Rule on its slice, escalate | Implement, merge |
| `worker` | Worker | Claim, heartbeat, register, submit | Satisfy an acceptance gate |
| `producer` | CI, runner, observer | Evidence for granted proofs | Prove its own work |
| `reader` | Dashboards | Read | Mutate |

## Who decides

The master applies non-weakening intent (create, release, unblock, add requirements) directly. Rewriting requirements, resolving escalations, rework, recovery, `manual:` attestation, proof grants and merge with automatic merging off are requested with `graphyard master decide GY-N ACTION REASON` and applied by a separate approver with `graphyard master approve GY-N DECISION REASON`; the server refuses an approver that requested the decision, held an assignment on the item, produced its evidence, or would receive the grant. Reviewers approve candidates, proof producers produce evidence, and the merge gate decides merges. A human-only decision parks the item (`graphyard park`) until the human answers (`graphyard answer` or **Work → Needs you**).

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
