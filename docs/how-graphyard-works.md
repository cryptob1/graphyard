<!-- page: Start here | 1 | lifecycle and authority. -->
# How Graphyard works

Graphyard decides whether work may advance; runtimes such as Herdr run the sessions ([glossary](glossary.md)).

## One trip from setup to Done

1. **Ready**: an item whose criteria name proofs is released and unblocked.
2. **Build**: a worker claims a lease and worktree, and submits a PR.
3. **Review**: an independent reviewer approves the exact commit.
4. **Test**: Graphyard observes CI itself.
5. **Acceptance**: granted producers report evidence for that commit — proofs the item's risk lane does not name are not required of it.
6. **Done**: Graphyard rechecks every gate, merges, and observes the merge.

A card stops at its first refusing gate, naming what is missing; nothing sets a stage directly.

## Risk lanes

Every item rides a **risk lane**, decided from the paths its change touches by the shipped path policy (`src/model/policy.ts`) and stamped on the item with its speed target, shown in `master status`: any path under `migrations/schema`, `auth/credentials`, `deploy/install` or the public API (`src/server/routes/`) rides **high**; a change only of tests or docs, or one kept inside a single module, rides **low**; everything else rides **medium**. The lane is an input to the one landability verdict (`src/model/gates.ts`), not a second set of gates: the verdict takes the item's lane and decides which facts it requires.

- **Low** lands with its required CI checks green and one approving review. Producer-run proofs and manual attestations are not required of it: a bad low-risk change is caught and reverted, not prevented.
- **Medium** adds its producer-run proofs (`unit:`, `integration:`).
- **High** keeps today's full path, manual attestations included; only the high lane names an approver decision among a rework round's required facts.

The lane never weakens a criterion otherwise: a recorded proof failure still returns the head in every lane, and a bootstrap obligation inherited from an earlier delivery is never waived. Speed targets ship per lane — low p50 30 min, medium 60 min, high 4 h — and are reported beside the lane.

![Bootstrap versus normal operation: one supervised worker, then a fleet with separate credentials.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: in bootstrap the human operator supervises one worker while gates are activated; normally the master dispatches to many workers, each with its own credential and worktree, while reviewers and producers judge candidates under the same gates.

## Who holds which authority

![Who holds which authority: the operator, Graphyard, Herdr-hosted sessions, reviewer and producer.](diagrams/roles-and-authority.svg)

Text equivalent: the human operator sends human-only decisions to Graphyard; Herdr hosts the master (`coordinator`), slice lead and worker (epoch, worktree); the reviewer is a GitHub identity and the producer holds a grant. Each session commands Graphyard under its own credential; merges go only through the guarded path. Colours follow the [legend](glossary.md#diagram-legend).

## Correctness rules

![Control-plane components: callers, engine, Postgres, reconciliation worker and GitHub.](diagrams/control-plane-components.svg)

Text equivalent: sessions, the dashboard and producers call the API; the engine applies each mutation in one locked Postgres transaction, appending an event; the reconciliation worker syncs GitHub, publishes the required check and runs the guarded merge; the webhook only wakes a job.

- Gates are deterministic checks of one candidate, `(PR, head SHA, base SHA)`, under the current policy revision; a push or base change invalidates old evidence.
- Every claim increments the epoch; commands from an old epoch or expired lease are refused.
- Evidence is attributed to its authenticated producer; the latest trusted record per proof and candidate wins, even a failure.
- History is append-only, and a retried command replays its original result.
- Graphyard merges only the exact authorized candidate, once; any other merge is a permanent violation. Merge is not [delivery](delivery.md).
