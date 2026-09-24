<!-- page: Start here | 2 | human operator, agent session, principal, lease, reviewer, proof producer, control plane, runtime: one definition each, plus the diagram legend. -->
# Glossary

One short definition and one canonical usage per term. Every guide in `docs/` uses these words in these senses; when a sentence needs a different sense, it says so explicitly. The diagrams in [How Graphyard works](how-graphyard-works.md) and [Architecture](architecture.md) use the legend at the end of this page.

## The eight distinctions

### 1. Human operator (human authority)

The person who administers a Graphyard installation. They hold an `admin` credential that declares `sessionKind: "human"`, and usually the GitHub repository-administrator identity as well.

Autonomy is the default: agents act without asking. The human operator keeps exactly three decisions: **goals and priorities**, **spending money or opening third-party accounts**, and **issuing credentials to people** (which includes approving a GitHub sudo prompt on their own device). Every other decision is made by one agent role and approved by a second, independent agent role; [Who decides](#who-decides) names both for each decision. A two-party decision is enforced by the control plane, not by convention: the approving identity is never the requester, never an identity that has held an assignment on the item, never the producer of evidence the decision rests on, and never the principal a grant would empower. Each refusal names its conflict, and requester, approver and reason are appended to the item's history. A declared human `admin` session may still make any of these decisions directly, but nothing waits for one: the engine's direct `resolve` and human-only intake (goals, policy and requirement changes, waivers) still require a declared human session, so agents resolve escalations through the two-party `resolve` decision instead.

**Canonical usage:** *human operator*. Bare *operator* always means this person. *Administrator* is the same person in a GitHub or deployment context. Never write *operator* for the scoped operator agent.

### 2. AI agent

A language-model program that reads and writes through an agent runtime. "Agent" says what kind of program it is, not what it may do; authority comes only from the credential it holds.

**Canonical usage:** *agent* alone only when the role does not matter. Otherwise name the role: *worker*, *master*, *approver*, *slice lead*, *reviewer*, *proof producer*, *operator agent*.

### 3. Agent session (Herdr-managed session or runtime)

One running instance of an agent inside a runtime: a Herdr tab, a Claude Code, Codex, Cursor, or opencode process, or a human at a terminal. A session has a transcript, a process, and a lifetime. The Graphyard roles are distinct sessions even when they use the same provider or account.

Two things are *not* agent sessions: a dashboard sign-in (the browser keeps a token in session storage) and `sessionKind`, which is a declaration on a credential saying whether a human or an AI holds it.

**Canonical usage:** *agent session* or *session*. *Runtime* is the software that hosts sessions. *Dashboard sign-in* for the browser.

### 4. Principal, role, and credential

A *principal* is an identity Graphyard authenticates: the `id` in `GRAPHYARD_PRINCIPALS` or the operator-agent registry. Its *role* is its authority class: `admin`, `coordinator`, `slice-lead`, `worker`, `producer`, `reader`, or `operator-agent`. Its *credential* (*token*) is the secret that proves the principal. Ownership, evidence trust, and every refusal are attributed to the principal, never to a runtime or a display name.

**Canonical usage:** *principal* for the identity, *role* for the authority class, *token* or *credential* for the secret. One principal per concurrent session.

### 5. Worker lease and worktree

A *lease* is time-limited ownership of one work item by one worker principal at one *epoch*; a heartbeat renews it; submitting the candidate (`complete`), release, or expiry ends it; and every claim raises the epoch. The *assigned worktree* is the Git worktree registered as the assignment's workspace `(host ID, absolute path)` with a globally reserved branch. Ownership ends when the lease ends, not when a session dies or a runtime says so.

**Canonical usage:** *lease*, *epoch*, *assigned worktree*. A *workspace* is the registered `(host, path)`; a *worktree* is the Git checkout at that path.

### 6. Independent reviewer and proof producer

A *reviewer* is a GitHub identity that approves the exact candidate head and is neither the pull-request author nor the Graphyard control-plane App. A reviewer session holds no Graphyard credential. A *proof producer* is a `producer` principal, usually a CI workflow or trusted runner, whose live grant authorizes exact proof names; its evidence is bound to the candidate head SHA, base SHA, and policy revision. Both are *independent*: never an implementer of the item, never a slice lead, never the worker's credential.

**Canonical usage:** *reviewer* and *proof producer*; *reviewer/proof producer* only when a sentence covers both. Never *the tester*.

### 7. Graphyard control plane

The server, Postgres database, dashboard, and CLI that record ownership, requirements, candidates, evidence, gate decisions, and merge authorization. Gates are deterministic evaluations, never a model's judgment. It has no client-controlled lifecycle-state endpoint and no administrative merge bypass. It runs no agents.

**Canonical usage:** *Graphyard* or *the control plane*. Graphyard *records*, *evaluates*, *refuses*, *observes*, and *authorizes*; it never *runs*, *supervises*, or *prompts* a session.

### 8. Herdr runtime

The session supervisor that launches, shows, and stops agent sessions, and the first packaged runtime integration. Herdr reports whether a session is alive; it never decides ownership, evidence, or progression. A healthy session is not a lease, and a dead session does not rewrite history.

**Canonical usage:** *Herdr* or *the Herdr runtime*. Other runtimes are named by product (*Claude Code*, *Codex*, *Cursor*, *opencode*) or collectively as *agent runtimes*.

## The roles at a glance

| Role (credential) | Normally held by | May | Never |
| --- | --- | --- | --- |
| `admin` | Human operator | Set goals and priorities; provision the master's agent identities once at onboarding (`master autonomy`); issue credentials to people; make any decision below directly (escalation resolution from a declared human session) | Mint trusted automated evidence; be shared with any AI session |
| `operator-agent` | The master's own operator-agent identity, and the separate approver identity (both provisioned by `master autonomy`); other scoped operator agents | Master identity: create, release, unblock, add requirements, select a review provider, request two-party decisions. Approver identity: approve decisions it did not request, on items it never held, not resting on its own evidence. Each only with the matching capability | Approve its own request; hold a lease; submit evidence except through an approved `attest` decision; merge |
| `coordinator` | Master (durable loop and optional visible session) | Read work and runtime health, dispatch, request the guarded merge, record deployment observations, settle a verified-dead quarantine | Claim, implement, produce evidence, revise requirements, bypass a gate |
| `slice-lead` | Slice lead | Rule on plans and failures in its slice, escalate | Implement, hold a lease, submit evidence, review its own slice, merge |
| `worker` | Worker | Claim, heartbeat, register its worktree, submit its candidate, record untrusted assertions | Receive `admin`, `coordinator`, or `producer` tokens; satisfy an acceptance gate |
| `producer` | Proof producer (CI workflow, trusted runner, or deployment observer) | Submit trusted evidence for granted proof names | Hold an assignment on the item it proves; act as a lead |
| `reader` | Dashboards | Read work, status, and events | Mutate anything |

A *master* is the coordinator: the durable `master run` loop plus the visible master session. The loop holds only the `coordinator` credential; the visible session also acts as the master's operator-agent identity for intent and decision requests. The *approver* is a separate agent session holding the approver operator-agent identity, launched per decision with `master approver GY-N DECISION`; it judges and approves, and never implements, requests, or produces evidence. *Slice lead*, *worker*, *reviewer*, *proof producer*, *approver*, and *operator agent* name a session by its role.

## Who decides

Every decision names the agent role that makes it and the independent agent role that approves it. The master requests two-party decisions with `graphyard master decide GY-N ACTION REASON`; the approver applies them with `graphyard master approve GY-N DECISION REASON` from its own session.

| Decision | Made by | Approved by |
| --- | --- | --- |
| Create work, release backlog work, clear a blocker, add requirements (`master create`, `release`, `unblock`, `requirements`) | Master (operator-agent identity) | Approver, when requested as a `release` or `unblock` decision; applied directly only because the intent is non-weakening, and the independent reviewer and proof producers judge every candidate that follows |
| Rewrite, remove, or narrow requirements (`decide … requirements`) | Master | Approver; the narrowing still raises a `requirement-weakening` escalation |
| Resolve an escalation (`decide … resolve`) | Master | Approver |
| Attest a `manual:` proof (`decide … attest`) | Master | Approver that produced no evidence for that proof |
| Authorize rework, or recover a delivered item's containment, attesting the previous worker stopped (`decide … rework`, `decide … recover`) | Master | Approver |
| Grant proof authority to a producer (`decide … grant`) | Master | Approver that is not the grantee |
| Approve a merge when automatic merging is off (`decide … merge`, then `master merge`) | Master | Approver that produced no evidence on the item |
| Select a review provider | Master (operator-agent identity) | The reviewer approves each candidate under it |
| Approve a candidate | Reviewer | Branch protection and the merge gate |
| Produce trusted evidence | Proof producer | The acceptance gate |
| Merge | Master (guarded merge) | The control plane's merge gate, rechecked on the exact candidate |
| GitHub administration, rotating agent principals in the roster, restarting the loop | Master | API verification and the audit ledger; a rotation preview that refuses to drop a live principal |
| Goals and priorities; spending money or opening third-party accounts; issuing credentials to people | **Human operator** | — |

An item that reaches one of those three records a typed *human-only request* (`graphyard park`), which ends its attempt's lease and parks it; the human operator answers it (`graphyard answer`, or **Work → Needs you** on the dashboard) and the master loop dispatches the item again. A *capacity escalation* is the other wait that belongs to nobody's judgement: every account of a role is spent, the item names each account and its reset, and the loop resumes the role on its own. See [human-only waits](master-agent-reference.md#human-only-waits) and [when a role has no account left](master-agent-sessions.md#when-a-role-has-no-account-left).

## Say this, not that

| Avoid | Write | Why |
| --- | --- | --- |
| "the operator" for automation | *operator agent* | Bare *operator* is the human. |
| "the agent" for a specific role | *worker*, *master*, *reviewer*, … | Authority follows the credential, not the program. |
| "the session" for a credential | *principal* or *credential* | A session can be restarted; the principal is what Graphyard attributes. |
| "Herdr owns the work" / "Herdr assigns" | *Graphyard records ownership; Herdr reports session health* | Ownership is a lease, not a live process. |
| "Graphyard runs the agents" | *the runtime runs the session; Graphyard records and gates* | The control plane runs no agents. |
| "the tester", "QA" | *proof producer* | Evidence trust is a granted credential, not a job title. |
| "user" | *human operator*, *reader*, or the role meant | *User* hides who holds authority. |
| "human" alone | *human operator* | The declared human session is what Graphyard checks. |
| "ask the operator to approve" | *request a decision; the approver agent approves* | Only goals, spending or accounts, and credentials for people wait for a human. |

## Diagram legend

Every repo-native diagram uses this key. The same legend is drawn inside each SVG.

| Shape and colour | Glossary term |
| --- | --- |
| Amber rounded box | Human operator (human authority) |
| Green rounded box | AI agent session holding one role and one credential |
| Blue square-cornered box | Graphyard control plane |
| Violet rounded box or container | Herdr runtime |
| Grey square-cornered box | GitHub and other external facts |
| Dashed chip inside a box | A credential, lease epoch, or assigned worktree the session holds |
| Solid arrow | An authenticated command or authority |
| Dashed arrow | An observation or health report, never authority |

Diagrams: [who holds which authority](how-graphyard-works.md#four-ai-agent-sessions), [bootstrap versus normal operation](how-graphyard-works.md#two-phases-one-clear-handoff), and [control-plane components](architecture.md#boundary). Each has a text equivalent beside it.
