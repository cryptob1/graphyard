<!-- page: Start here | 1 | lifecycle and authority. -->
# How Graphyard works

Graphyard decides whether work advances; runtimes such as Herdr run sessions.

## One trip from setup to Done

1. **Ready**: released, unblocked, criteria naming proofs.
2. **Build**: a worker claims a lease and worktree, then submits a PR.
3. **Review**: an independent reviewer approves the exact commit.
4. **Test**: Graphyard observes CI itself.
5. **Acceptance**: granted producers report the proofs its [lane](#risk-lanes) requires for that commit.
6. **Done**: Graphyard rechecks every gate, merges, observes it.

A card stops at its first refusing gate, naming what is missing; nothing sets stages directly.

## Risk lanes

The path policy (`src/model/policy.ts`) puts every item in a **risk lane** from its changed paths (renames by both endpoints); the lane sets what landing requires; `master status` shows its p50 target.

- **High** (4 h): schema, persistence, auth, credentials, principals, public API, operator agent, proof grants, install and deploy paths; unobserved changes. Needs producer proofs, `manual:` attestations and a two-party decision per rework.
- **Medium** (60 min): everything else; adds producer-run proofs (`unit:`, `integration:`).
- **Low** (30 min): test-only, docs-only or single-module changes. Needs required CI and one approval.

Every lane requires `e2e:` proofs and inherited bootstrap obligations. Low and medium reworks need no approver (recorded as `graphyard-risk-lane`).

## Who holds which authority

![Bootstrap versus normal operation: one supervised worker, then a fleet.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: in bootstrap the human operator supervises one worker while gates activate; then the master dispatches many workers, each with its own credential and worktree.

![Authority held by the operator, Graphyard, Herdr sessions, reviewer and producer.](diagrams/roles-and-authority.svg)

Text equivalent: the operator sends human-only decisions; Herdr hosts master, slice lead and worker; the reviewer is a GitHub identity, the producer a grant holder; each uses its own credential; merges take only the guarded path. Colours follow the [legend](glossary.md#diagram-legend).

## Correctness rules

![Control-plane components: callers, engine, Postgres, reconciliation worker and GitHub.](diagrams/control-plane-components.svg)

Text equivalent: callers use the API; the engine applies each mutation and event in one locked Postgres transaction; the reconciliation worker syncs GitHub, publishes the required check and runs the guarded merge; webhooks only wake jobs.

- Gates are deterministic checks of one candidate, `(PR, head SHA, base SHA)`, under the current policy revision; a push or base change invalidates old evidence.
- Each claim bumps the epoch; old-epoch or expired-lease commands are refused.
- Evidence is attributed to its authenticated producer; the latest trusted record per proof and candidate wins, even a failure.
- History is append-only (routine rows compacted after retention); a retry within a day replays the original result.
- Graphyard merges only the exact authorized candidate, once; any other merge is a permanent violation. Merge is not [delivery](delivery.md).
