<!-- page: Start here | 2 | definitions, usage. -->
# Glossary

For every reader and guide: one definition and one canonical usage per term.

## The eight distinctions

### 1. Human operator (human authority)

- **Who:** administers a Graphyard installation, usually also the GitHub repository.
- **Credential:** `admin`, declaring `sessionKind: "human"`.
- **Decides:** only three decisions ([who decides](#who-decides)); every other is an agent's, approved by an [independent agent](operator-automation.md#two-party-decisions); a declared human session may make any directly.
- **Canonical usage:** *human operator*; bare *operator* means this person, *administrator* same person in a GitHub or deployment context.
- **Never:** *operator* for the scoped operator agent, *user* for anyone, *ask the operator to approve* for a two-party decision an approver agent applies.

### 2. AI agent

Language-model program reading and writing through an agent runtime. "Agent" names the program kind, not what it may do: authority comes only from its credential.

**Canonical usage:** *agent* alone only when role does not matter; otherwise name it: *worker*, *master*, *approver*, *slice lead*, *reviewer*, *proof producer*, *operator agent*.

### 3. Agent session (Herdr-managed session or runtime)

- **Is:** one running agent instance inside a runtime, with transcript, process and lifetime.
- **Is not:** dashboard sign-in, keeping a token in browser session storage; nor `sessionKind`, a credential's declaration whether a human or AI holds it.
- **Canonical usage:** *agent session* or *session*; *runtime* for software hosting sessions, *dashboard sign-in* for the browser.

### 4. Principal, role, and credential

- ***Principal*:** identity Graphyard authenticates, the `id` in `GRAPHYARD_PRINCIPALS` or the operator-agent registry.
- ***Role*:** its authority class: `admin`, `coordinator`, `slice-lead`, `worker`, `producer`, `reader`, `operator-agent`.
- ***Credential*:** secret proving it.
- **Attach to the principal, never runtime or display name:** ownership, evidence trust and every refusal.
- **Canonical usage:** *principal*, *role*, *token* or *credential*. One principal per concurrent session.

### 5. Worker lease and worktree

- ***Lease*:** time-limited ownership of one work item by one worker principal at one *epoch*.
- **Lifecycle:** heartbeat renews it; `complete`, release or expiry ends it; every claim raises the epoch.
- ***Assigned worktree*:** Git worktree registered as the assignment's workspace `(host ID, absolute path)` with a globally reserved branch.
- **Canonical usage:** *lease*, *epoch*, *assigned worktree*; *workspace* for registered `(host, path)`, *worktree* for Git checkout there.

### 6. Independent reviewer and proof producer

- ***Reviewer*:** GitHub identity approving the exact candidate head, neither the pull-request author nor the control-plane App, holding no Graphyard credential.
- ***Proof producer*:** `producer` principal (usually a CI workflow or trusted runner) whose live grant authorizes exact proof names and whose evidence binds to the candidate head, base and policy revision.
- ***Independent*:** both; never an implementer, slice lead or the worker's credential.
- **Canonical usage:** *reviewer*, *proof producer*; *reviewer/proof producer* only when a sentence covers both.
- **Never:** *the tester* or *QA*: evidence trust is a granted credential, not a job title.

### 7. Graphyard control plane

Server, Postgres database, dashboard and CLI recording ownership, requirements, candidates, evidence, gate decisions and merge authorization; its gates are deterministic evaluations, never a model's judgment.

**Canonical usage:** *Graphyard* or *the control plane*. It *records*, *evaluates*, *refuses*, *observes* and *authorizes*; never *runs*, *supervises* or *prompts* a session.

### 8. Herdr runtime

Session supervisor launching, showing and stopping agent sessions, and the first packaged runtime integration, reporting whether a session is alive, never deciding ownership, evidence or progression.

**Canonical usage:** *Herdr* or *the Herdr runtime*; name other runtimes by product (*Claude Code*, *Codex*, *Cursor*, *opencode*) or collectively *agent runtimes*.

## The roles at a glance

| Role (credential) | May | Never |
| --- | --- | --- |
| `admin` | Human operator: set goals and priorities; provision the master's agent identities at onboarding; issue credentials to people; create and release work, revise requirements, rework, participate as a worker, attest `manual:` proofs, grant proof authority; resolve escalations and record human-only intake from a declared human session; from any session kind, settle a control-plane-raised `lease-loss` the ledger explains, citing its attestation | Mint trusted automated evidence; be shared with any AI session |
| `operator-agent` | The master's identity, the separate approver identity and other scoped operator agents: only their configured intent and policy capabilities (`intent:create`, `intent:ready`, `intent:unblock`, `policy:requirements`, `policy:review-provider`, `policy:bootstrap`) and `decision:*` requests inside a server-enforced repository and work allowlist; the approver identity approves decisions it did not request, on items it never held, not resting on its own evidence | Approve its own request; hold a lease; submit evidence except through an approved `attest` decision; merge |
| `coordinator` | Master: read work and runtime health, dispatch, acquire, verify or cancel bounded merge execution authority, record deployment observation on delivered work, settle a quarantine whose supervisor it verified dead on the registered host | Claim, implement, produce evidence, revise requirements, bypass a gate |
| `slice-lead` | Slice lead: record rulings in its own slice, escalate | Implement, hold a lease, submit evidence, review its own slice, merge; every lifecycle mutation refused and recorded ([delegation](delegation.md)) |
| `worker` | Worker: claim work, renew and release its lease, register its workspace, report blockers, submit its candidate, record untrusted assertions | Receive `admin`, `coordinator` or `producer` tokens; satisfy an acceptance gate |
| `producer` | Proof producer: submit evidence; only proof names a live grant authorizes are trusted | Hold an assignment on the item it proves; lead a slice |
| `reader` | Dashboards: inspect work, status and events | Mutate anything |

## Who decides

- **Master requests a two-party decision:** `master decide GY-N ACTION REASON`
- **Approver applies it, in its own session:** `master approve GY-N DECISION REASON`

The master decides, approved by:

- **Create work, release backlog work, clear a blocker, add requirements, widen scope:** applied directly: non-weakening intent, judged by reviewer and producers
- **Rewrite, remove or narrow requirements:** approver; narrowing still raises a `requirement-weakening` escalation
- **Resolve an escalation; authorize rework or containment recovery, attesting the worker stopped:** approver
- **Attest a `manual:` proof:** approver that produced no evidence for that proof
- **Grant proof authority to a producer:** approver that is not the grantee
- **Approve a merge with automatic merging off:** approver that produced no evidence on the item
- **Select a review provider:** the reviewer approves each candidate
- **Merge (guarded merge):** the merge gate, rechecked on the exact candidate
- **GitHub administration, rotating agent principals, restarting the loop:** API verification and audit ledger; a preview refusing to drop a live principal

Others decide:

- **Approve a candidate:** reviewer, under branch protection and the merge gate
- **Produce trusted evidence:** proof producer, under the acceptance gate
- **Goals and priorities; spending money or opening third-party accounts; issuing credentials to people:** **Human operator**, alone

## Diagram legend

Every repo-native diagram uses this key, drawn inside each SVG too.

- **Amber rounded box:** Human operator
- **Green rounded box:** AI agent session, one role, one credential
- **Blue square-cornered box:** Graphyard control plane
- **Violet rounded box or container:** Herdr runtime
- **Grey square-cornered box:** GitHub and other external facts
- **Dashed chip inside a box:** Credential, lease epoch or assigned worktree the session holds
- **Solid arrow:** Authenticated command or authority
- **Dashed arrow:** Observation or health report, never authority

