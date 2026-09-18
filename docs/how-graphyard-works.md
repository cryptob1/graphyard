# How Graphyard works

Graphyard helps a team move one well-defined piece of work from an idea to a verified merge. It records who owns the work, what must be true, and whether every delivery gate is satisfied.

> **The short version:** Graphyard decides whether work is allowed to move forward. Agent runtimes such as Herdr help run the sessions that do the work.

## One trip from setup to Done

1. **Setup**
   An operator connects the repository, GitHub enforcement, individual identities, and trusted proof producers. The team writes its working rules in `AGENTS.md`. [Start with repository onboarding](onboarding.md).
2. **Create**
   The operator creates a work item with a clear outcome, dependencies, planned files, and acceptance criteria. Each criterion names the proof that will show it works.
3. **Ready**
   Graphyard checks that the item is released, unblocked, and that its dependencies are finished. Until then, nobody can claim it.
4. **Claim**
   A worker claims the ready item under its own identity. Graphyard issues a time-limited lease and a new epoch. The launcher or the separate handoff/worktree step then registers the assigned branch and worktree; the worker waits for that assigned workspace before editing.
5. **Build**
   The worker changes only the assigned work, renews the lease, and follows the repository instructions. If ownership is lost, the worker stops. External tools may run the session, but they do not own the assignment.
6. **Review**
   The worker opens a pull request and submits its exact commit to Graphyard. The configured independent reviewer examines that candidate; the implementation worker cannot approve its own work.
7. **Test**
   Required CI checks run against the candidate commit. Graphyard observes GitHub rather than trusting a worker's report that tests passed.
8. **Acceptance**
   Authorized proof producers report the required behavioral evidence. Proof is tied to the candidate and current requirements, so a new commit or requirement revision makes stale proof insufficient.
9. **Merge**
   The master asks Graphyard to merge. Graphyard rechecks the exact candidate, every gate, fresh GitHub state, and merge authorization. A refusal stays a refusal; nobody bypasses it.
10. **Done**
    Graphyard marks the item Done only after it observes the authorized merge. The history keeps the assignment, evidence, decisions, and delivered commit.

Every box is a checkpoint. A blocked box explains what is missing; it is not an invitation to skip ahead.

## Two phases, one clear handoff

1. **Phase 1 · Bootstrap — Human operator → one implementation agent.** The MVP is unchanged: the human operator connects the managed (target) repository and activates its gates while directly supervising a single, worker-scoped implementation agent. The agent never receives the operator or GitHub credentials used for setup. No multi-agent operation yet.
2. **Phase 2 · Automated operation — Human → goals, required decisions, oversight.** Only after the managed repository is connected, its gates are active, and GY-30 scoped operator automation is configured does the installation fan out to the four independent AI agent sessions below. The human supplies goals, required decisions, and oversight, and is not expected to perform the routine Operator, Master, Worker, or Reviewer/proof-producer duties. Phase 2 is the target for this installation, not its present state: scoped operator automation is planned and not active today, and until the scoped operator-agent principal is provisioned, Graphyard accepts requirements and policy changes only from the unrestricted human administrator.

## Four AI agent sessions

| Independent session | Duty |
| --- | --- |
| **Operator agent** | Executes human-approved bounded intent: it turns goals into scoped work and may add requirements but never remove or rewrite them. Exceptions and approval decisions stay with the human operator, and its automation is least-privilege, never unrestricted admin authority. This duty is future-facing until GY-30 automation is provisioned: today no scoped operator-agent credential exists, so only the unrestricted human administrator holds this authority. |
| **Master agent** | Watches readiness and runtime health, dispatches ready work, routes handoffs, and requests policy-allowed merges. It never implements or overrides Graphyard. |
| **Worker agent** | Claims work, uses its assigned worktree, builds, tests, opens the PR, and submits the candidate. It stops on lease loss. |
| **Reviewer/proof-producer agent** | Independently reviews the exact candidate or reports an approved proof. It does not inherit trust from the worker. |

These are distinct AI sessions, even if they use the same provider or account. Graphyard enforces separation with **authenticated principal identities, scoped credentials, and authority checks**. The runtime or deployment—for example, Herdr—must keep the sessions independent; Graphyard does not verify runtime isolation. Separation is only as real as the principals Graphyard knows: Worker, Master/coordinator, and Reviewer/proof-producer map to enforced credentials today, while the scoped Operator agent remains a designed contract, not an active credential, until GY-30 automation is provisioned.

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

Herdr can launch and watch a worker, but a healthy Herdr session does not prove ownership or acceptance. A disconnected session does not rewrite Graphyard history. When the two views differ, use Graphyard for assignment and delivery truth and Herdr for live session health.

## When a gate says no

Read the refusal on the work item, fix the underlying cause, and let the same gate evaluate again. Common examples are an unfinished dependency, an expired lease, a changed PR commit, missing independent review, a failed CI check, or missing acceptance proof. Requirements are never weakened just to make a candidate pass.

## Go deeper only when you need to

- [Architecture and correctness model](architecture.md) — transactions, epochs, candidates, reconciliation, and merge authority.
- [Agent protocol and API](protocol.md) — exact worker and producer commands.
- [Coordination and recovery drills](coordination.md) — requirement revision, retries, expiry, and recovery behavior.
- [GitHub enforcement](github.md) — branch protection and the external enforcement boundary.
- [Herdr integration](herdr.md) — launcher and live-session setup.
