<!-- page: Start here | 1 | lifecycle, authority. -->
# How Graphyard works

Graphyard gates work; runtimes such as Herdr run sessions ([glossary](glossary.md)).

## Lifecycle

1. **Ready**: released, unblocked, criteria naming proofs.
2. **Build**: a worker claims a lease and worktree and submits a PR.
3. **Review**: an independent reviewer approves the exact commit.
4. **Test**: Graphyard observes CI itself.
5. **Acceptance**: granted producers report evidence.
6. **Done**: Graphyard rechecks every gate, merges, observes the merge.

A card stops at its first refusing gate, naming what is missing; nothing sets a stage directly.

![Bootstrap's one supervised worker versus the normal fleet.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: bootstrap is one operator-supervised worker while gates activate; normally the master dispatches many, each with its own credential and worktree, under the same gates.

## Authority

![Authority of operator, Graphyard, sessions, reviewer and producer.](diagrams/roles-and-authority.svg)

Text equivalent: the operator sends human-only decisions; Herdr hosts the master (`coordinator`), slice lead and worker (epoch, worktree); the reviewer is a GitHub identity, the producer holds a grant; each has its own credential; merges take only the guarded path ([legend](glossary.md#diagram-legend)).

## Correctness rules

![Control plane: callers, engine, Postgres, reconciler, GitHub.](diagrams/control-plane-components.svg)

Text equivalent: sessions, dashboard and producers call the API; the engine applies each mutation, with its event, in one locked Postgres transaction; the reconciliation worker syncs GitHub, publishes the required check and merges; the webhook only wakes a job.

- Gates check one candidate `(PR, head SHA, base SHA)` deterministically under the current policy revision; a push or base change invalidates old evidence.
- Each claim increments the epoch; old-epoch or expired-lease commands are refused.
- Evidence is attributed to its authenticated producer; the latest trusted record per proof and candidate wins, even a failure.
- History is append-only (routine rows compacted after retention); a retry within a day replays the original result.
- Graphyard merges only the exact authorized candidate, once; any other merge is a permanent violation. Merge is not [delivery](delivery.md).
