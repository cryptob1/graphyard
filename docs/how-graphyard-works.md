# How Graphyard works

Graphyard helps a team move one well-defined piece of work from an idea to a verified merge. It records who owns the work, what must be true, and whether every delivery gate is satisfied.

> **The short version:** Graphyard decides whether work is allowed to move forward. Agent runtimes such as Herdr run the sessions that do the work. The words on this page — human operator, agent session, principal, lease, reviewer, proof producer, control plane, runtime — are defined once in the [glossary](glossary.md).

## One trip from setup to Done

1. **Setup**
   The human operator connects the repository, GitHub enforcement, one principal per session, and the trusted proof producers. The team writes its working rules in `AGENTS.md`. [Start with repository onboarding](onboarding.md).
2. **Create**
   The human operator creates a work item with a clear outcome, dependencies, planned files, and acceptance criteria. Each criterion names the proof that will show it works.
3. **Ready**
   Graphyard checks that the item is released, unblocked, and that its dependencies are finished. Until then, nobody can claim it.
4. **Claim**
   A worker claims the ready item under its own principal. Graphyard issues a time-limited lease and a new epoch. The launcher or the separate handoff/worktree step then registers the assigned branch and worktree; the worker waits for that assigned worktree before editing.
5. **Build**
   The worker changes only the assigned work, renews the lease, and follows the repository instructions. If ownership is lost, the worker stops. A runtime such as Herdr may host the session, but it does not own the assignment.
6. **Review**
   The worker opens a pull request and submits its exact commit to Graphyard. The independent reviewer examines that candidate; the worker cannot approve its own work.
7. **Test**
   Required CI checks run against the candidate commit. Graphyard observes GitHub rather than trusting a worker's report that tests passed.
8. **Acceptance**
   Proof producers with a live grant report the required behavioral evidence. Proof is tied to the candidate and current requirements, so a new commit or requirement revision makes stale proof insufficient.
9. **Merge**
   The master asks Graphyard to merge. Graphyard rechecks the exact candidate, every gate, fresh GitHub state, and merge authorization. A refusal stays a refusal; nobody bypasses it.
10. **Done**
    Graphyard marks the item Done only after it observes the authorized merge. The history keeps the assignment, evidence, decisions, and delivered commit.

Every box is a checkpoint. A blocked box explains what is missing; it is not an invitation to skip ahead.

## Two phases, one clear handoff

1. **Phase 1 · Bootstrap — Human operator → one implementation agent.** The MVP is unchanged: the human operator connects the managed (target) repository and activates its gates while directly supervising a single, worker-scoped implementation agent. The agent never receives the operator or GitHub credentials used for setup. No multi-agent operation yet.
2. **Phase 2 · Automated operation — Human → goals, required decisions, oversight.** Only after the managed repository is connected, its gates are active, and GY-30 scoped operator automation is configured does the installation fan out to the four independent AI agent sessions below. The human supplies goals, required decisions, and oversight, and is not expected to perform the routine Operator, Master, Worker, or Reviewer/proof-producer duties. Scoped operator automation is shipped and available as an opt-in, least-privilege credential that a human administrator provisions; it is a configuration step, not future work. Until this installation provisions the scoped operator-agent principal, the unrestricted human administrator still makes requirements and policy changes. [Provision scoped operator automation](operator-automation.md).

![Bootstrap single-agent operation versus normal multi-agent operation. Phase 1: the human operator directly supervises one worker session, which holds a worker credential, one lease epoch, and one assigned worktree and talks to the Graphyard control plane, which exchanges facts with GitHub. Phase 2: the human operator supplies goals and human-only decisions; an optional scoped operator agent sends bounded intent; the master loop, optional slice leads, and independent reviewer and proof producer sessions read ready work and gate state; the master dispatches to many worker sessions, each with its own credential, lease epoch, and worktree; the gates and credential boundaries are the same in both phases.](diagrams/bootstrap-vs-normal.svg)

Text equivalent of the diagram above. **Phase 1, bootstrap:** the human operator (amber; `admin`, `sessionKind: "human"`) directly supervises one worker session (green; `worker`, one lease epoch, one assigned worktree). The worker sends claim, heartbeat, and submit commands to the Graphyard control plane (blue), which exchanges PR, CI, protection, and merge facts with GitHub (grey). No operator agent, master loop, slice lead, or reviewer session exists yet, and every gate is already enforced. **Phase 2, normal operation:** the same human operator supplies goals and the human-only decisions. An optional scoped operator agent (green; `operator-agent`) sends bounded intent to Graphyard. The master loop (`coordinator`), optional slice leads (`slice-lead`), and the independent reviewer and proof producers (`producer`) read ready work and gate state from Graphyard. The master dispatches — an invitation, not ownership — to many worker sessions, each with its own `worker` credential, lease epoch, and assigned worktree. Workers push branches and open pull requests on GitHub. Herdr (violet) hosts the sessions and reports their health; the gates and credential boundaries do not change between the phases. The legend inside the image is the [glossary's diagram legend](glossary.md#diagram-legend).

## Four AI agent sessions

| Independent session | Duty |
| --- | --- |
| **Operator agent** | Executes human-approved bounded intent: it turns goals into scoped work and may add requirements but never remove or rewrite them. Exceptions and approval decisions stay with the human operator, and its automation is least-privilege, never unrestricted admin authority. The GY-30 credential behind this duty is shipped and opt-in: an administrator provisions it per installation, and until this installation provisions the scoped operator-agent principal the unrestricted human administrator holds this authority. |
| **Master agent** | Watches readiness and runtime health, dispatches ready work, routes handoffs, and requests policy-allowed merges. It never implements or overrides Graphyard. |
| **Worker agent** | Claims work, uses its assigned worktree, builds, tests, opens the PR, and submits the candidate. It stops on lease loss. |
| **Reviewer/proof-producer agent** | Independently reviews the exact candidate or reports an approved proof. It does not inherit trust from the worker. |

A fifth session joins only where slice delegation is configured: a **slice lead agent** coordinates one formal slice — approving or rejecting plans, classifying failures, requesting reruns, sending work back, and escalating, always citing a written rule ID and a reason — and never implements, holds a worker lease, submits evidence, bypasses a gate, or merges. See [slice-lead delegation](delegation.md).

These are distinct AI sessions, even if they use the same provider or account. Graphyard enforces separation with **authenticated principal identities, scoped credentials, and authority checks**. The runtime or deployment—for example, Herdr—must keep the sessions independent; Graphyard does not verify runtime isolation. Separation is only as real as the principals Graphyard knows: Worker, Master/coordinator, and Reviewer/proof-producer map to enforced credentials today, and the scoped Operator agent uses a shipped credential type that each installation provisions before that session becomes active.

![Who holds which authority in Graphyard. The human operator, holding an admin credential declared human, makes the human-only decisions and sends them to the Graphyard control plane. The Herdr runtime hosts the master, slice lead, and worker sessions, each with one credential; beside them are the reviewer, a separate GitHub identity with no Graphyard credential, the proof producer with a producer credential and grant, and the optional scoped operator agent. Sessions send authenticated commands to Graphyard; the worker pushes its branch and opens the pull request on GitHub; the reviewer approves the exact head on GitHub. Graphyard observes GitHub facts and merges only through the guarded path.](diagrams/roles-and-authority.svg)

Text equivalent of the diagram above, top to bottom. The **human operator** (amber; `admin`, `sessionKind: "human"`) sets goals, releases backlog work, revises requirements, resolves escalations, attests manual proofs, and approves merges when automatic merging is off; a solid arrow labelled *human-only decisions* leads to the **Graphyard control plane** (blue), which records ownership (lease and epoch), requirements, the candidate (PR, head SHA, base SHA), evidence, gate decisions, and merge authorization, with no lifecycle-state endpoint and no merge bypass. Below it, the **Herdr runtime** (violet container) hosts three green sessions, each with a dashed credential chip: the **master** (`coordinator`: dispatches ready work, shepherds review, requests the guarded merge), the **slice lead** (`slice-lead`: rules on plans and failures inside one slice, never implements or merges), and the **worker** (`worker`, `lease · epoch`, `worktree`: claims one item, edits only its assigned worktree, opens the PR, submits the exact commit, stops on lease loss). Beside the container sit the **reviewer** (a separate GitHub identity that approves the exact head and holds no Graphyard credential), the **proof producer** (`producer` plus a grant; a CI workflow or trusted runner whose evidence is bound to head, base, and policy revision), and the optional scoped **operator agent** (`operator-agent`: adds intent and requirements, never removes them). Solid arrows from the sessions up to Graphyard carry claim, heartbeat, submit, dispatch, merge request, evidence, and bounded intent, each under its own credential. Solid arrows down to **GitHub** (grey) carry the worker's push and pull request and the reviewer's approval of the exact head. Graphyard observes the PR, reviews, checks, and protection, publishes the required `Graphyard / merge` check, and merges only through the guarded exact-candidate path; Herdr reports whether a session is alive and never decides ownership or progression.

## The boundaries that do not move

- **Graphyard is the source of ownership and progression truth.** Runtime health is not ownership.
- **Gates decide progression:** CI, trusted evidence, independent review, and the merge gate.
- **Workers stay untrusted.** They never receive operator, scoped operator-agent, coordinator, or trusted evidence-producer credentials.
- **There is no shortcut.** No client-controlled lifecycle-state endpoint and no administrative merge bypass.

## Graphyard and Herdr answer different questions

| Graphyard: delivery authority | Herdr: runtime supervision |
| --- | --- |
| Who currently owns this work, at which lease epoch? | Is the agent session alive, paused, or gone? |
| What are the current requirements and dependencies? | Which runtime, machine, or provider is hosting it? |
| Which exact PR commit is the candidate? | Did the prompt reach the session? |
| Have review, test, acceptance, and merge gates passed? | Does the session need an operator's attention? |
| Was the merge authorized and observed, making the item Done? | Should a session be restarted or handed off? |

Herdr can launch and watch a worker session, but a healthy session does not prove ownership or acceptance. A disconnected session does not rewrite Graphyard history. When the two views differ, use Graphyard for assignment and delivery truth and Herdr for live session health.

## When a gate says no

Read the refusal on the work item, fix the underlying cause, and let the same gate evaluate again. Common examples are an unfinished dependency, an expired lease, a changed PR commit, missing independent review, a failed CI check, or missing acceptance proof. Requirements are never weakened just to make a candidate pass.

## Go deeper only when you need to

- [Glossary](glossary.md) — the eight distinctions every guide relies on, and the diagram legend.
- [Architecture and correctness model](architecture.md) — transactions, epochs, candidates, reconciliation, and merge authority.
- [Agent protocol and API](protocol.md) — exact worker and producer commands.
- [Coordination and recovery drills](coordination.md) — requirement revision, retries, expiry, and recovery behavior.
- [GitHub enforcement](github.md) — branch protection and the external enforcement boundary.
- [Herdr integration](herdr.md) — launcher and live-session setup.
