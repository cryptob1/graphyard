<!-- page: Start here | 1 | the lifecycle and authority model in five minutes, with diagrams. -->
# How Graphyard works

Graphyard decides whether work may move forward. Agent runtimes such as Herdr run the sessions that do the work. Terms are defined in the [glossary](glossary.md).

## One trip from setup to Done

1. **Setup** — connect the repository, GitHub enforcement, one principal per session, and trusted proof producers ([onboarding](onboarding.md)).
2. **Create** — a work item with an outcome, dependencies, planned files, and criteria that each name a proof.
3. **Ready** — released, unblocked, dependencies Done. Until then nobody can claim it.
4. **Claim** — a worker claims under its own principal and gets a lease and epoch, then works only in its assigned worktree.
5. **Build** — the worker renews the lease and stops if ownership is lost.
6. **Review** — the worker opens a PR and submits the exact commit; an independent reviewer approves it.
7. **Test** — Graphyard observes CI on GitHub rather than trusting a report.
8. **Acceptance** — proof producers with a live grant report evidence bound to the candidate and current requirements.
9. **Merge** — the master asks; Graphyard rechecks the exact candidate and every gate first.
10. **Done** — only after Graphyard observes the authorized merge.

## Two phases, one clear handoff

1. **Bootstrap** — the human operator supervises one worker-scoped agent while connecting the repository and activating its gates.
2. **Automated operation** — once gates are active and [scoped operator automation](operator-automation.md) is provisioned, the master, workers, reviewers and producers run as separate sessions; the human supplies goals and the three human-only decisions.

![Bootstrap versus normal operation: in phase 1 the human operator supervises one worker session talking to Graphyard; in phase 2 the master, workers, reviewers and producers each hold their own credential.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: in bootstrap, the human operator (`admin`) supervises one worker (`worker`, one lease epoch, one worktree) that claims, heartbeats and submits to Graphyard, which exchanges PR, CI and merge facts with GitHub. In normal operation the human supplies goals; an optional operator agent sends bounded intent; the master (`coordinator`) dispatches to many workers, each with its own credential, epoch and worktree; reviewers and producers judge candidates. Gates and credential boundaries are the same in both phases. Colours follow the [diagram legend](glossary.md#diagram-legend).

## Four AI agent sessions

| Session | Duty |
| --- | --- |
| **Operator agent** | Turns goals into scoped work; may add requirements, never remove them. |
| **Master agent** | Dispatches ready work, routes handoffs, requests guarded merges; never implements. |
| **Worker agent** | Claims, builds in its worktree, opens the PR, submits; stops on lease loss. |
| **Reviewer/proof-producer agent** | Independently reviews the exact candidate or reports a granted proof. |

Where delegation is configured, a **slice lead** rules on plans and failures in one slice ([delegation](delegation.md)). Graphyard enforces separation through principals and scoped credentials; the runtime must keep sessions independent.

![Who holds which authority: the human operator sends human-only decisions to Graphyard; Herdr hosts master, slice lead and worker sessions; reviewer and proof producer act independently.](diagrams/roles-and-authority.svg)

Text equivalent: the human operator (`admin`, human session) sends human-only decisions to the Graphyard control plane, which records leases, requirements, candidates, evidence, gates and merge authorization. Herdr hosts the master (`coordinator`), slice lead (`slice-lead`) and worker (`worker`, lease epoch, worktree). The reviewer is a separate GitHub identity with no Graphyard credential; the proof producer holds `producer` plus a grant; the optional operator agent adds intent. Sessions send commands to Graphyard under their own credentials; the worker pushes and opens the PR on GitHub; Graphyard observes GitHub and merges only through the guarded path.

## The boundaries that do not move

- Graphyard is the source of ownership and progression truth; runtime health is not ownership.
- CI, trusted evidence, independent review and the merge gate decide progression.
- Workers never receive operator, coordinator or producer credentials.
- No lifecycle-state endpoint and no merge bypass. Requirements are never weakened to make a candidate pass.

## Graphyard and Herdr answer different questions

| Graphyard | Herdr |
| --- | --- |
| Who owns this work, at which epoch? | Is the session alive? |
| What are the requirements? | Which machine hosts it? |
| Which commit is the candidate, and have its gates passed? | Did the prompt arrive? Should it be restarted? |

When they disagree, Graphyard is right about ownership and delivery; Herdr about session health.
