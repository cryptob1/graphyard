<!-- page: Start here | 1 | lifecycle and authority. -->
# How Graphyard works

For a newcomer: how work reaches a verified merge, and who may move it.

## One trip from setup to Done

The operator connects the repository, GitHub enforcement, one principal per session and the trusted proof producers; the working rules go in `AGENTS.md` ([onboarding](onboarding.md)). Each item is created with an outcome, dependencies, planned files and acceptance criteria naming its proofs, then travels through six gates in order, each a deterministic evaluation it cannot skip:

1. **`ready`:** the item is released and unblocked and its dependencies are finished
2. **`build`:** one worker principal claimed it at a new lease epoch, in a registered worktree, and submitted an exact commit
3. **`review`:** an independent reviewer approved that exact head
4. **`test`:** Graphyard observed the required CI checks on GitHub, rather than taking them on report
5. **`acceptance`:** trusted evidence binds that head, base and policy revision, so a new commit or a revision makes an old pass insufficient
6. **`merge`:** the guarded merge rechecks everything immediately before the GitHub call

Only an independently observed authorized merge marks the item **Done**; history keeps the assignment, evidence, decisions and delivered commit.

## Two phases, one clear handoff

1. **Phase 1 · Bootstrap.** The human operator connects the managed repository and activates its gates while supervising a single worker-scoped implementation agent, never receiving the operator or GitHub credentials used for setup.
2. **Phase 2 · Normal operation.**
   - The operator supplies goals and the three human-only decisions.
   - An operator agent may send bounded intent.
   - The master loop (`coordinator`), optional slice leads (`slice-lead`) and the independent reviewer and proof producers (`producer`) read ready work and gate state.
   - The master dispatches (an invitation, not ownership) to many worker sessions.

**Both phases:** identical gates and credential boundaries; Herdr hosts the sessions and reports their health.

![Bootstrap single-agent operation beside normal multi-agent operation, under the same gates and credential boundaries.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: the two phases above.

## Four AI agent sessions

Operator agent, master, worker, and reviewer or proof producer: [what each may and may never do](glossary.md#the-roles-at-a-glance).

![Who holds which authority; the text equivalent follows.](diagrams/roles-and-authority.svg)

Text equivalent, top to bottom:

- **Human operator:** sends the human-only decisions to the **control plane**.
- **Control plane:** records ownership, requirements, the candidate, evidence, gate decisions and merge authorization, no lifecycle-state endpoint and no merge bypass.
- **Herdr runtime:** hosts the **master**, **slice lead** and **worker**, beside the **reviewer**, **proof producer** and optional **operator agent**.
- **Arrows up to Graphyard:** claim, heartbeat, submit, dispatch, merge request, evidence and bounded intent, each under its own credential.
- **Arrows down to GitHub:** the worker's push and pull request, and the reviewer's approval of the exact head.

Both diagrams use the [diagram legend](glossary.md#diagram-legend).

## The boundaries that do not move

- **Graphyard is the source of ownership and progression truth.** Runtime health is not ownership.
- **Gates decide progression:** CI, trusted evidence, independent review and the merge gate.
- **Workers stay untrusted.** They never receive operator, scoped operator-agent, coordinator or trusted evidence-producer credentials.
- **There is no shortcut.** No client-controlled lifecycle-state endpoint and no administrative merge bypass.

## Graphyard and Herdr answer different questions

- **Graphyard answers:** who owns the work at which epoch, what the requirements are, which commit is the candidate, whether the gates passed and the merge was authorized and observed.
- **Herdr answers:** whether the session is alive, where it runs, whether the prompt reached it, whether it needs attention.

Neither answers the other's question ([the eight distinctions](glossary.md#the-eight-distinctions)).

## When a gate says no

1. Read the refusal on the work item.
2. Fix the underlying cause: an unfinished dependency, an expired lease, a changed commit, a missing review, a failed check or missing proof.
3. Let the same gate evaluate again.

Requirements are never weakened to make a candidate pass. Go deeper only when needed:

- [operations](operations.md): the recipe
- [coordination](coordination.md): requirements and overlap
- [GitHub enforcement](github.md): the checks and the merge
- [agent protocol](protocol.md): the exact commands
