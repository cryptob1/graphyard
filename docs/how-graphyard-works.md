<!-- page: Start here | 1 | lifecycle, authority. -->
# How Graphyard works

Graphyard decides whether work advances; runtimes (Herdr) run sessions, each starting with a role-scoped ≤500-word digest (decisions, recurring faults, recent merges) from applied records (`.graphyard/project-memory.json`; `projectMemory` in `master status`).

## One trip from setup to Done

1. **Ready**: released, unblocked, criteria name proofs.
2. **Build**: a worker claims lease, worktree; submits a PR.
3. **Review**: an independent reviewer approves the exact commit.
4. **Test**: Graphyard observes CI.
5. **Acceptance**: granted producers report proofs its [lane](#risk-lanes) requires.
6. **Done**: Graphyard rechecks gates, merges, observes.

## From goal to work items

A goal passes intake, acceptance, approval, planning, approval and delivery. `graphyard goal FILE` records it; the acceptance role writes outcomes and required `uat` cases ([validation](validation.md)), approved by a non-author. Once merged, the `planner` role writes an architecture note (at most 400 words) and items, each naming outcomes served, cases to pass, `plannedFiles` and predecessors. A plan leaving an outcome uncovered, letting parallel items share a file (`dir/**` included), naming a criterion twice or touching a required case is refused with the reason; three refused rounds (before or at approval) hand the goal to the master. A role at its registry concurrency defers, never starting a fallback. Another identity approves the plan (`goal plan-approve`); the loop then creates and releases items (`planned`, then `delivering`), dispatching none before its dependencies are delivered. The goal is `delivered` once every item is done and production serves it: a loop-recorded deployment covering its merge, plus a passing smoke proof where policy asks.

## Risk lanes

`src/model/policy.ts` sets **risk lane** (`low`, `medium`, `high`) by paths.

- **High** (4 h): `migrations/schema`, `auth/credentials`, `src/store/`, authentication, principals, public API and its assembler, credential bootstrap (`src/server/`), operator agent, proof grants, `src/install/`, `deploy/`, Dockerfile, `compose.yaml`, unobserved changes. Producer proofs, `manual:` attestations, two-party rework.
- **Medium** (60 min): remainder; adds producer-run `unit:`/`integration:`.
- **Low** (30 min): test-only, docs-only, single-module. Required CI and one approval only.

All lanes require `e2e:` proofs; low/medium reworks need no approver (approved by `graphyard-risk-lane`), nor does any lane's rework whose ground the record shows on the exact head: a trusted proof failed on it, an approver refused its `manual:` attestation (the loop then requests that rework itself), or the control plane's own test merge onto the moved base conflicted, not GitHub's reading alone (`src/model/rework-ground.ts`). A head already returned to a worker has spent its ground (a later retry-cap rework waits). Grounded reworks are no [intervention](dashboard.md).

## Who holds which authority

![Bootstrap: one supervised worker; normal operation: a fleet.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: in bootstrap the human operator supervises one worker; later the master dispatches many, each with own credential.

![Authority of operator, Graphyard, Herdr sessions, reviewer, producer.](diagrams/roles-and-authority.svg)

Text equivalent: operator makes human-only decisions; Herdr hosts master (`coordinator`), slice lead, worker (epoch, worktree); reviewer, producer hold credentials; guarded path merges. Colours: [legend](glossary.md#diagram-legend).

## Correctness rules

![Control plane: callers, engine, Postgres, reconciliation worker, GitHub.](diagrams/control-plane-components.svg)

Text equivalent: mutations, events commit in locked Postgres transactions; reconciliation syncs GitHub, which merges passing heads; webhooks wake jobs.

Gates are deterministic checks of one candidate, `(PR, head SHA, base SHA)`; claims bump the epoch; latest trusted proof wins; merge is not [delivery](delivery.md).
