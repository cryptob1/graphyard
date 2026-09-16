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
   A worker claims the ready item under its own identity. Graphyard issues a time-limited lease and a new epoch, then reserves that attempt's branch and worktree.
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

## Who does what

| Role | Responsible for | Boundary |
| --- | --- | --- |
| **Operator** | Sets up the repository and identities; creates and revises work and requirements; resolves policy-level blockers. | Does not turn an implementation claim into approval, mint automated test results, or bypass a failed gate. |
| **Master** | Watches Graphyard and runtime health; dispatches ready work; routes durable handoffs; requests routine merges when policy allows. | Does not implement work, hold worker leases, produce evidence, or override Graphyard. Dispatch is an invitation, not ownership. |
| **Worker** | Claims under its own identity; uses the assigned worktree; builds, tests, opens the PR, and submits the candidate. | Must stop after lease loss. Cannot self-review, grant itself trusted proof credentials, or change requirements merely to pass. |
| **Reviewer / proof producer** | Independently reviews the candidate or runs an approved proof and reports evidence for its allowlisted proof name. | Does not inherit trust from the worker. Evidence must match the exact candidate and requirements; it cannot authorize unrelated work. |

One person may operate more than one tool, but the credentials and duties stay separate. In particular, an implementation session never becomes a trusted evidence producer just because it ran a test.

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
