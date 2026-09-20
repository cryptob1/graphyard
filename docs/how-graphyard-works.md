<!-- page: Start here | 1 | the lifecycle and authority model. -->
# How Graphyard works

For a newcomer: how work reaches a verified merge, and who may move it.

## One trip from setup to Done

The operator connects the repository, GitHub enforcement, one principal per session and the trusted proof producers, and the working rules go in `AGENTS.md` ([onboarding](onboarding.md)). Each item is then created with an outcome, dependencies, planned files and acceptance criteria naming the proofs that will show it works, and travels through six gates in order — **ready**, **build**, **review**, **test**, **acceptance**, **merge** — each a deterministic evaluation the item cannot skip: released and unblocked with finished dependencies; claimed under one worker principal at a new lease epoch in a registered worktree; an exact submitted commit an independent reviewer approves; required CI checks Graphyard observes on GitHub rather than takes on report; trusted evidence bound to that head, base and policy revision, so a new commit or a requirement revision makes an old pass insufficient; and a guarded merge that rechecks everything immediately before the GitHub call. Only an independently observed authorized merge marks the item **Done**, and history keeps the assignment, evidence, decisions and delivered commit.

## Two phases, one clear handoff

**Phase 1 · Bootstrap.** The human operator connects the managed repository and activates its gates while directly supervising a single worker-scoped implementation agent, which never receives the operator or GitHub credentials used for setup.

![Bootstrap single-agent operation beside normal multi-agent operation: in phase 1 the human operator supervises one worker session against the control plane and GitHub; in phase 2 an operator agent, the master loop, slice leads, reviewer and proof producers surround many worker sessions, under the same gates and credential boundaries. Described in full below.](diagrams/bootstrap-vs-normal.svg)

Text equivalent of the diagram above. **Phase 1, bootstrap:** the human operator (`admin`, `sessionKind: "human"`) directly supervises one worker session — one credential, one lease epoch, one assigned worktree — whose claim, heartbeat and submit commands reach the control plane, which exchanges PR, CI, protection and merge facts with GitHub. No operator agent, master loop, slice lead or reviewer session exists yet, and every gate is already enforced. **Phase 2, normal operation:** the same operator supplies goals and the human-only decisions; an optional operator agent sends bounded intent; the master loop (`coordinator`), optional slice leads (`slice-lead`) and the independent reviewer and proof producers (`producer`) read ready work and gate state; and the master dispatches — an invitation, not ownership — to many worker sessions, each with its own credential, lease epoch and worktree, which push branches and open pull requests. Herdr hosts the sessions and reports their health; gates and credential boundaries are identical in both phases. The legend inside the image is the [glossary's diagram legend](glossary.md#diagram-legend).

## Four AI agent sessions

Operator agent, master, worker, and reviewer or proof producer: [what each may and may never do](glossary.md#the-roles-at-a-glance).

![Who holds which authority in Graphyard: the human operator above the control plane, the Herdr runtime hosting master, slice-lead and worker sessions, and the reviewer, proof producer and operator agent beside them, with authenticated commands running up to Graphyard and pushes, pull requests and approvals down to GitHub. Described in full below.](diagrams/roles-and-authority.svg)

Text equivalent of the diagram above, top to bottom. The **human operator** (`admin`, `sessionKind: "human"`) sends the human-only decisions to the **Graphyard control plane**, which records ownership, requirements, the candidate (PR, head SHA, base SHA), evidence, gate decisions and merge authorization, with no lifecycle-state endpoint and no merge bypass. Below it the **Herdr runtime** hosts the **master** (`coordinator`), the **slice lead** (`slice-lead`) and the **worker** (with its lease epoch and worktree); beside them sit the **reviewer** (a separate GitHub identity holding no Graphyard credential), the **proof producer** (`producer` plus a grant) and the optional **operator agent** — [what each may do](glossary.md#the-roles-at-a-glance). Arrows up to Graphyard carry claim, heartbeat, submit, dispatch, merge request, evidence and bounded intent, each under its own credential; arrows down to **GitHub** carry the worker's push and pull request and the reviewer's approval of the exact head. Graphyard observes the PR, reviews, checks and protection, publishes `Graphyard / merge` and merges only through the guarded path; Herdr reports whether a session is alive and never decides ownership or progression.

## The boundaries that do not move

- **Graphyard is the source of ownership and progression truth.** Runtime health is not ownership.
- **Gates decide progression:** CI, trusted evidence, independent review and the merge gate.
- **Workers stay untrusted.** They never receive operator, scoped operator-agent, coordinator or trusted evidence-producer credentials.
- **There is no shortcut.** No client-controlled lifecycle-state endpoint and no administrative merge bypass.

## Graphyard and Herdr answer different questions

Graphyard answers who owns the work at which epoch, what the requirements are, which commit is the candidate, whether the gates passed and whether the merge was authorized and observed. Herdr answers whether the session is alive, where it runs, whether the prompt reached it and whether it needs attention or a restart. Neither answers the other's question ([distinction 8](glossary.md#8-herdr-runtime)).

## When a gate says no

Read the refusal on the work item, fix the underlying cause, and let the same gate evaluate again — an unfinished dependency, an expired lease, a changed commit, missing review, a failed check or missing proof. Requirements are never weakened just to make a candidate pass. Go deeper only when you need to:
