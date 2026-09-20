<!-- page: Start here | 1 | lifecycle and authority. -->
# How Graphyard works

For a newcomer: how work reaches a verified merge, and who may move it.

## One trip from setup to Done

The operator connects the repository, GitHub enforcement, one principal per session and the trusted proof producers, and the working rules go in `AGENTS.md` ([onboarding](onboarding.md)). Each item is created with an outcome, dependencies, planned files and acceptance criteria naming its proofs, then travels through six gates in order, each a deterministic evaluation it cannot skip:

| Gate | Passes when |
| --- | --- |
| `ready` | The item is released and unblocked and its dependencies are finished |
| `build` | One worker principal claimed it at a new lease epoch, in a registered worktree, and submitted an exact commit |
| `review` | An independent reviewer approved that exact head |
| `test` | Graphyard observed the required CI checks on GitHub, rather than taking them on report |
| `acceptance` | Trusted evidence binds that head, base and policy revision, so a new commit or a revision makes an old pass insufficient |
| `merge` | The guarded merge rechecks everything immediately before the GitHub call |

Only an independently observed authorized merge marks the item **Done**, and history keeps the assignment, evidence, decisions and delivered commit.

## Two phases, one clear handoff

**Phase 1 · Bootstrap.** The human operator connects the managed repository and activates its gates while supervising a single worker-scoped implementation agent, which never receives the operator or GitHub credentials used for setup. **Phase 2 · Normal operation.** The operator supplies goals and the three human-only decisions; an operator agent may send bounded intent; the master loop, optional slice leads and the independent reviewer and proof producers read ready work and gate state; and the master dispatches — an invitation, not ownership — to many worker sessions. Gates and credential boundaries are identical in both phases, and Herdr hosts the sessions and reports their health.

![Bootstrap single-agent operation beside normal multi-agent operation: in phase 1 the human operator supervises one worker session against the control plane and GitHub; in phase 2 an operator agent, the master loop, slice leads, reviewer and proof producers surround many worker sessions, under the same gates and credential boundaries, as the two paragraphs above describe.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: phase 1 is the operator and one worker session against the control plane and GitHub, every gate already enforced; phase 2 adds the master loop (`coordinator`), slice leads (`slice-lead`), the reviewer and proof producers (`producer`) and an optional operator agent around many worker sessions.

## Four AI agent sessions

Operator agent, master, worker, and reviewer or proof producer: [what each may and may never do](glossary.md#the-roles-at-a-glance).

![Who holds which authority: the human operator sends the human-only decisions to the Graphyard control plane, which records ownership, requirements, the candidate, evidence, gate decisions and merge authorization. The Herdr runtime below it hosts the master, slice-lead and worker sessions, with the reviewer, proof producer and operator agent beside them. Arrows up to Graphyard carry claim, heartbeat, submit, dispatch, merge request, evidence and bounded intent, each under its own credential; arrows down to GitHub carry the worker's push and pull request and the reviewer's approval of the exact head.](diagrams/roles-and-authority.svg)

Text equivalent, top to bottom: the **human operator** sends the human-only decisions to the **control plane**, which records ownership, requirements, the candidate, evidence, gate decisions and merge authorization, with no lifecycle-state endpoint and no merge bypass. The **Herdr runtime** hosts the **master**, **slice lead** and **worker**, beside the **reviewer**, **proof producer** and optional **operator agent** — [what each may do](glossary.md#the-roles-at-a-glance).

Both diagrams use the [diagram legend](glossary.md#diagram-legend), which is also drawn inside each SVG.

## The boundaries that do not move

- **Graphyard is the source of ownership and progression truth.** Runtime health is not ownership.
- **Gates decide progression:** CI, trusted evidence, independent review and the merge gate.
- **Workers stay untrusted.** They never receive operator, scoped operator-agent, coordinator or trusted evidence-producer credentials.
- **There is no shortcut.** No client-controlled lifecycle-state endpoint and no administrative merge bypass.

## Graphyard and Herdr answer different questions

Graphyard answers who owns the work at which epoch, what the requirements are, which commit is the candidate, whether the gates passed and whether the merge was authorized and observed. Herdr answers whether the session is alive, where it runs, whether the prompt reached it and whether it needs attention. Neither answers the other's question ([the eight distinctions](glossary.md#the-eight-distinctions)).

## When a gate says no

Read the refusal on the work item, fix the underlying cause — an unfinished dependency, an expired lease, a changed commit, a missing review, a failed check or missing proof — and let the same gate evaluate again. Requirements are never weakened to make a candidate pass. Go deeper only when you need to: [operations](operations.md) for the recipe, [coordination](coordination.md) for requirements and overlap, [GitHub enforcement](github.md) for the checks and the merge, and the [agent protocol](protocol.md) for the exact commands.
