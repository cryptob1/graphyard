<!-- page: Start here | 1 | lifecycle, authority. -->
# How Graphyard works

For a newcomer: how work reaches a verified merge, and who may move it.

## One trip from setup to Done

The operator connects the repository, GitHub enforcement, one principal per session and the trusted proof producers; working rules go in `AGENTS.md` ([onboarding](onboarding.md)). Each item is created with an outcome, dependencies, planned files and acceptance criteria naming its proofs, then passes six gates in order, each a deterministic evaluation it cannot skip:

1. **`ready`:** released and unblocked, its dependencies finished
3. **`review`:** an independent reviewer approved that exact head

Only an independently observed authorized merge marks the item **Done**; history keeps the assignment, evidence, decisions and delivered commit.

## Two phases, one clear handoff

2. **Phase 2 · Normal operation.** The operator supplies goals and the three human-only decisions, an operator agent may send bounded intent, and the master loop (`coordinator`), optional slice leads (`slice-lead`) and the independent reviewer and proof producers (`producer`) read ready work and gate state while the master dispatches — an invitation, not ownership — to many worker sessions.

**Both phases:** identical gates and credential boundaries, Herdr hosting the sessions and reporting their health.

![Bootstrap single-agent operation beside normal multi-agent operation, under the same gates and credential boundaries.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: the two phases above.

## Four AI agent sessions

Operator agent, master, worker, and reviewer or proof producer: [what each may and may never do](glossary.md#the-roles-at-a-glance).

![Who holds which authority; the text equivalent follows.](diagrams/roles-and-authority.svg)

Text equivalent, top to bottom: the **human operator** sends the human-only decisions to the **control plane**, which records ownership, requirements, the candidate, evidence, gate decisions and merge authorization, with no lifecycle-state endpoint and no merge bypass; the **Herdr runtime** hosts the **master**, **slice lead** and **worker** beside the **reviewer**, **proof producer** and optional **operator agent**; arrows up to Graphyard are claim, heartbeat, submit, dispatch, merge request, evidence and bounded intent, each under its own credential; arrows down to GitHub are the worker's push and pull request and the reviewer's approval of the exact head.

Both diagrams use the [diagram legend](glossary.md#diagram-legend).

## The boundaries that do not move

- **Workers stay untrusted.** They never receive operator, scoped operator-agent, coordinator or trusted evidence-producer credentials.
- **There is no shortcut.** No client-controlled lifecycle-state endpoint and no administrative merge bypass.

## When a gate says no

Read the refusal on the work item, fix its cause — an unfinished dependency, expired lease, changed commit, missing review, failed check or missing proof — and let the same gate evaluate again. Requirements are never weakened to make a candidate pass. Deeper: [operations](operations.md), [coordination](coordination.md), [GitHub enforcement](github.md), [agent protocol](protocol.md).
