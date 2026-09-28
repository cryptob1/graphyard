<!-- page: Start here | 1 | lifecycle and authority. -->
# How Graphyard works

Graphyard decides whether work may advance; runtimes such as Herdr run the sessions ([glossary](glossary.md)).

## One trip from setup to Done

1. **Ready**: an item whose criteria name proofs is released and unblocked.
2. **Build**: a worker claims a lease and worktree, and submits a PR.
3. **Review**: an independent reviewer approves the exact commit.
4. **Test**: Graphyard observes CI itself.
5. **Acceptance**: granted producers report evidence for that commit — the proofs its lane demands of it (see [risk lanes](#risk-lanes)).
6. **Done**: Graphyard rechecks every gate, merges, and observes the merge.

A card stops at its first refusing gate, naming what is missing; nothing sets a stage directly.

## Risk lanes

Every item rides a **risk lane**, decided from the paths its change touches by the shipped path policy (`src/model/policy.ts`) and stamped on the item with its speed target, shown in `master status`: any path under `migrations/schema`, `auth/credentials`, the repository's schema and persistence layer (`src/store/`), authentication and principals (`src/server/auth.ts`, `src/server/principals.ts`), the public API (`src/server/routes/`) or the installation and deployment surfaces (`src/install/`, the `deploy/` tree, the Dockerfile, `compose.yaml`) rides **high**; a change only of tests or docs, or one kept inside one module — every path sharing the same leading segments, so `src/model/` is one module while `src/model/index.ts` beside `src/cli/index.ts` is two — rides **low**; everything else rides **medium**. A rename is classified from both of its endpoints, so moving a file out of a high-risk tree stays high. The lane is an input to the one landability verdict (`src/model/gates.ts`), not a second set of gates: the verdict takes the item's lane, decides which facts it requires of the change, and reports the lane with its speed target.

- **Low** is landable with its required CI checks green and one approving review: the lane demands none of the change's producer-run proofs (`unit:`, `integration:`) or manual attestations — a bad low-risk change is caught and reverted, not prevented.
- **Medium** adds the change's producer-run proofs (`unit:`, `integration:`).
- **High** adds manual attestations (`manual:`) too: the full path.

The lane decides which of the change's own criterion proofs are demanded — at the acceptance gate, at the review hold (no reviewer is asked about a head whose demanded proofs have not run), and at producer dispatch (no session is launched for a proof the lane lifts). What no lane lifts: a family it does not scale (`e2e:` proofs stay demanded in every lane), a bootstrap obligation inherited from an earlier delivery, and a recorded proof failure — a failure still returns the head in every lane. Rework stays a two-party decision — the master requests it and a separate approver approves it — in every lane, because that is the repository's standing authority contract. Speed targets ship per lane — low p50 30 min, medium 60 min, high 4 h — and are reported beside the lane.

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
