<!-- page: Start here | 2 | one definition per role term. -->
# Glossary

For every reader and guide: one definition and one canonical usage per term.

## The eight distinctions

### 1. Human operator (human authority)

The person who administers a Graphyard installation, holding an `admin` credential that declares `sessionKind: "human"` and usually the GitHub repository-administrator identity as well. Only three decisions wait for this person ([who decides](#who-decides)); every other one is made by an agent and approved by an [independent agent](operator-automation.md#two-party-decisions). A declared human session may still make any of them directly.

**Canonical usage:** *human operator*. Bare *operator* always means this person, and *administrator* is the same person in a GitHub or deployment context. Never write *operator* for the scoped operator agent, never *user* for anyone (it hides who holds authority), and never *ask the operator to approve* for a two-party decision an approver agent applies.

### 2. AI agent

A language-model program that reads and writes through an agent runtime. "Agent" says what kind of program it is, not what it may do: authority comes only from the credential it holds.

**Canonical usage:** *agent* alone only when the role does not matter; otherwise name it — *worker*, *master*, *approver*, *slice lead*, *reviewer*, *proof producer*, *operator agent*.

### 3. Agent session (Herdr-managed session or runtime)

One running instance of an agent inside a runtime, with a transcript, a process and a lifetime. Not agent sessions: a dashboard sign-in, which keeps a token in browser session storage, and `sessionKind`, a declaration on a credential saying whether a human or an AI holds it.

**Canonical usage:** *agent session* or *session*. *Runtime* is the software hosting sessions; *dashboard sign-in* for the browser.

### 4. Principal, role, and credential

A *principal* is an identity Graphyard authenticates: the `id` in `GRAPHYARD_PRINCIPALS` or the operator-agent registry. Its *role* is its authority class — `admin`, `coordinator`, `slice-lead`, `worker`, `producer`, `reader` or `operator-agent` — and its *credential* (*token*) is the secret proving it. Ownership, evidence trust and every refusal are attributed to the principal, never to a runtime or display name.

**Canonical usage:** *principal* for the identity, *role* for the authority class, *token* or *credential* for the secret. One principal per concurrent session.

### 5. Worker lease and worktree

A *lease* is time-limited ownership of one work item by one worker principal at one *epoch*; a heartbeat renews it, submitting the candidate (`complete`), release or expiry ends it, and every claim raises the epoch. The *assigned worktree* is the Git worktree registered as the assignment's workspace `(host ID, absolute path)` with a globally reserved branch.

**Canonical usage:** *lease*, *epoch*, *assigned worktree*. A *workspace* is the registered `(host, path)`, a *worktree* the Git checkout there.

### 6. Independent reviewer and proof producer

A *reviewer* is a GitHub identity approving the exact candidate head, neither the pull-request author nor the control-plane App, holding no Graphyard credential. A *proof producer* is a `producer` principal — usually a CI workflow or trusted runner — whose live grant authorizes exact proof names and whose evidence is bound to the candidate head SHA, base SHA and policy revision. Both are *independent*: never an implementer of the item, never a slice lead, never the worker's credential.

**Canonical usage:** *reviewer* and *proof producer*; *reviewer/proof producer* only when a sentence covers both. Never *the tester* or *QA*: evidence trust is a granted credential, not a job title.

### 7. Graphyard control plane

The server, Postgres database, dashboard and CLI recording ownership, requirements, candidates, evidence, gate decisions and merge authorization. Gates are deterministic evaluations, never a model's judgment.

**Canonical usage:** *Graphyard* or *the control plane*. Graphyard *records*, *evaluates*, *refuses*, *observes*, and *authorizes*; it never *runs*, *supervises*, or *prompts* a session.

### 8. Herdr runtime

The session supervisor that launches, shows and stops agent sessions, and the first packaged runtime integration. It reports whether a session is alive; it never decides ownership, evidence or progression.

**Canonical usage:** *Herdr* or *the Herdr runtime*. Name other runtimes by product (*Claude Code*, *Codex*, *Cursor*, *opencode*) or collectively as *agent runtimes*.

## The roles at a glance

| Role (credential) | Normally held by | May | Never |
| --- | --- | --- | --- |
| `admin` | Human operator | Set goals and priorities; provision the master's agent identities once at onboarding; issue credentials to people; create and release work, revise requirements, rework, participate as a worker, attest `manual:` proofs, grant proof authority; resolve escalations and record human-only intake from a declared human session; from any session kind, settle a control-plane-raised `lease-loss` the ledger explains by citing its attestation | Mint trusted automated evidence; be shared with any AI session |
| `operator-agent` | The master's own operator-agent identity and the separate approver identity, plus other scoped operator agents | Only the configured intent and policy capabilities (`intent:create`, `intent:ready`, `intent:unblock`, `policy:requirements`, `policy:review-provider`, `policy:bootstrap`) and `decision:*` requests inside a server-enforced repository and work allowlist. The approver identity approves decisions it did not request, on items it never held, not resting on its own evidence | Approve its own request; hold a lease; submit evidence except through an approved `attest` decision; merge |
| `coordinator` | Master | Read work and runtime health, dispatch, acquire, verify or cancel the engine's bounded merge execution authority, record the deployment observation on delivered work, settle a quarantine whose supervisor it verified dead on the registered host | Claim, implement, produce evidence, revise requirements, bypass a gate |
| `slice-lead` | Slice lead | Record rulings on work in its own slice, escalate | Implement, hold a lease, submit evidence, review its own slice, merge; every lifecycle mutation is refused and recorded ([delegation](delegation.md)) |
| `worker` | Worker | Claim work, renew and release its own lease, register its workspace, report blockers, submit its candidate, record untrusted assertions | Receive `admin`, `coordinator` or `producer` tokens; satisfy an acceptance gate |
| `producer` | Proof producer | Submit evidence; only proof names a live grant authorizes are trusted | Hold an assignment on the item it proves; act as a lead |
| `reader` | Dashboards | Inspect work, status and events | Mutate anything |

## Who decides

Every decision names the agent role that makes it and the independent role that approves it. The master requests a two-party decision with `master decide GY-N ACTION REASON`; the approver applies it with `master approve GY-N DECISION REASON` from its own session.

| Decision | Made by | Approved by |
| --- | --- | --- |
| Create work, release backlog work, clear a blocker, add requirements, widen scope on request | Master | Applied directly: the intent is non-weakening, and reviewer and producers judge the candidate |
| Rewrite, remove or narrow requirements | Master | Approver; the narrowing still raises a `requirement-weakening` escalation |
| Resolve an escalation; authorize rework or containment recovery, attesting the previous worker stopped | Master | Approver |
| Attest a `manual:` proof | Master | Approver that produced no evidence for that proof |
| Grant proof authority to a producer | Master | Approver that is not the grantee |
| Approve a merge when automatic merging is off | Master | Approver that produced no evidence on the item |
| Select a review provider | Master | The reviewer approves each candidate under it |
| Approve a candidate | Reviewer | Branch protection and the merge gate |
| Produce trusted evidence | Proof producer | The acceptance gate |
| Merge | Master (guarded merge) | The control plane's merge gate, rechecked on the exact candidate |
| GitHub administration, rotating agent principals, restarting the loop | Master | API verification and the audit ledger; a preview refusing to drop a live principal |
| Goals and priorities; spending money or opening third-party accounts; issuing credentials to people | **Human operator** | — |

## Diagram legend

Every repo-native diagram uses this key, which is also drawn inside each SVG.

- **Amber rounded box:** Human operator
- **Green rounded box:** AI agent session holding one role and one credential
- **Blue square-cornered box:** Graphyard control plane
- **Violet rounded box or container:** Herdr runtime
- **Grey square-cornered box:** GitHub and other external facts
- **Dashed chip inside a box:** A credential, lease epoch, or assigned worktree the session holds
- **Solid arrow:** An authenticated command or authority
- **Dashed arrow:** An observation or health report, never authority

