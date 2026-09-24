<!-- page: Start here | 1 | the lifecycle and authority model, with diagrams. -->
# How Graphyard works

Graphyard decides whether work may move forward; runtimes such as Herdr run the sessions that do it. Terms are in the [glossary](glossary.md).

## One trip from setup to Done

1. **Setup** — repository, GitHub enforcement, principals, producers ([onboarding](onboarding.md)).
2. **Create** — an outcome, dependencies, planned files, criteria naming proofs.
3. **Ready** — released, unblocked, dependencies Done.
4. **Claim** — a worker gets a lease, an epoch and an assigned worktree.
5. **Build** — renewing the lease; stop on losing it.
6. **Review** — an independent reviewer approves the exact PR commit.
7. **Test** — Graphyard observes CI itself.
8. **Acceptance** — granted producers report evidence bound to the candidate.
9. **Merge** — Graphyard rechecks every gate first.
10. **Done** — only after the authorized merge is observed.

## Two phases, one clear handoff

1. **Bootstrap** — the human operator supervises one worker while the repository's gates are activated.
2. **Automated operation** — with [operator automation](operator-automation.md), master, workers, reviewers and producers run as separate sessions.

![Bootstrap versus normal operation: one supervised worker in phase 1; master, workers, reviewers and producers each with their own credential in phase 2.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: in bootstrap the human operator supervises one worker (one epoch, one worktree) that talks to Graphyard, which exchanges facts with GitHub. In normal operation the master dispatches to many workers, each with its own credential, epoch and worktree, and reviewers and producers judge candidates. Gates are the same in both phases. Colours follow the [legend](glossary.md#diagram-legend).

## Four AI agent sessions

| Session | Duty |
| --- | --- |
| **Operator agent** | Turns goals into scoped work; adds requirements, never removes them |
| **Master agent** | Dispatches, routes handoffs, requests guarded merges; never implements |
| **Worker agent** | Builds in its worktree, submits; stops on lease loss |
| **Reviewer/proof-producer agent** | Independently reviews or proves the exact candidate |

An optional **slice lead** rules on one slice ([delegation](delegation.md)).

![Who holds which authority: the human operator, Graphyard, Herdr-hosted sessions, and the independent reviewer and producer.](diagrams/roles-and-authority.svg)

Text equivalent: the human operator sends human-only decisions to Graphyard. Herdr hosts the master (`coordinator`), slice lead and worker (`worker`, epoch, worktree). The reviewer is a GitHub identity with no Graphyard credential; the producer holds `producer` and a grant. Each session commands Graphyard under its own credential; Graphyard observes GitHub and merges only through the guarded path.

## Graphyard and Herdr answer different questions

| Graphyard | Herdr |
| --- | --- |
| Who owns this work, at which epoch? | Is the session alive? |
| Which commit is the candidate; have its gates passed? | Which machine hosts it; should it restart? |

Graphyard is right about ownership and delivery, Herdr about session health. There is no lifecycle-state endpoint or merge bypass, and requirements are never weakened to pass a candidate.
