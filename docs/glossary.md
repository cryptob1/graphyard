# Glossary

One short definition and one canonical usage per term. Every guide in `docs/` uses these words in these senses; when a sentence needs a different sense, it says so explicitly. The diagrams in [How Graphyard works](how-graphyard-works.md) and [Architecture](architecture.md) use the legend at the end of this page.

## The eight distinctions

### 1. Human operator (human authority)

The person who administers a Graphyard installation. They hold an `admin` credential that declares `sessionKind: "human"`, and usually the GitHub repository-administrator identity as well.

Human-only authorities: setting goals, releasing backlog work, revising requirements, choosing review providers, clearing blockers, resolving escalations, attesting `manual:` proofs, authorizing rework, and approving a merge when automatic merging is off. Graphyard refuses these from any credential that declares `sessionKind: "ai"` or declares nothing.

**Canonical usage:** *human operator*. Bare *operator* always means this person. *Administrator* is the same person in a GitHub or deployment context. Never write *operator* for the scoped operator agent.

### 2. AI agent

A language-model program that reads and writes through an agent runtime. "Agent" says what kind of program it is, not what it may do; authority comes only from the credential it holds.

**Canonical usage:** *agent* alone only when the role does not matter. Otherwise name the role: *worker*, *master*, *slice lead*, *reviewer*, *proof producer*, *operator agent*.

### 3. Agent session (Herdr-managed session or runtime)

One running instance of an agent inside a runtime: a Herdr tab, a Claude Code, Codex, Cursor, or opencode process, or a human at a terminal. A session has a transcript, a process, and a lifetime. The Graphyard roles are distinct sessions even when they use the same provider or account.

Two things are *not* agent sessions: a dashboard sign-in (the browser keeps a token in session storage) and `sessionKind`, which is a declaration on a credential saying whether a human or an AI holds it.

**Canonical usage:** *agent session* or *session*. *Runtime* is the software that hosts sessions. *Dashboard sign-in* for the browser.

### 4. Principal, role, and credential

A *principal* is an identity Graphyard authenticates: the `id` in `GRAPHYARD_PRINCIPALS` or the operator-agent registry. Its *role* is its authority class: `admin`, `coordinator`, `slice-lead`, `worker`, `producer`, `reader`, or `operator-agent`. Its *credential* (*token*) is the secret that proves the principal. Ownership, evidence trust, and every refusal are attributed to the principal, never to a runtime or a display name.

**Canonical usage:** *principal* for the identity, *role* for the authority class, *token* or *credential* for the secret. One principal per concurrent session.

### 5. Worker lease and worktree

A *lease* is time-limited ownership of one work item by one worker principal at one *epoch*; a heartbeat renews it, expiry or release ends it, and every claim raises the epoch. The *assigned worktree* is the Git worktree registered as the assignment's workspace `(host ID, absolute path)` with a globally reserved branch. Ownership ends when the lease ends, not when a session dies or a runtime says so.

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
| `admin` | Human operator | Create and release work, revise requirements, attest `manual:` proofs, grant proof authority, rework, resolve escalations | Mint trusted automated evidence; be shared with any AI session |
| `operator-agent` | Operator agent (optional, scoped) | Create intent, release or unblock in-scope work, add requirements | Remove or rewrite requirements, hold a lease, submit evidence, merge |
| `coordinator` | Master (durable loop and optional visible session) | Read work and runtime health, dispatch, request the guarded merge, record deployment observations, settle a verified-dead quarantine | Claim, implement, produce evidence, revise requirements, bypass a gate |
| `slice-lead` | Slice lead | Rule on plans and failures in its slice, escalate | Implement, hold a lease, submit evidence, review its own slice, merge |
| `worker` | Worker | Claim, heartbeat, register its worktree, submit its candidate, record untrusted assertions | Receive `admin`, `coordinator`, or `producer` tokens; satisfy an acceptance gate |
| `producer` | Proof producer (CI workflow, trusted runner, or deployment observer) | Submit trusted evidence for granted proof names | Hold an assignment on the item it proves; act as a lead |
| `reader` | Dashboards | Read work, status, and events | Mutate anything |

A *master* is the coordinator: the durable `master run` loop plus an optional visible master session, holding only the `coordinator` credential. *Slice lead*, *worker*, *reviewer*, *proof producer*, and *operator agent* name a session by its role.

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
