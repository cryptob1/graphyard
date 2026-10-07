<!-- page: Start here | 1 | lifecycle and authority. -->
# How Graphyard works

Graphyard decides whether work advances; runtimes (Herdr) run sessions.

## One trip from setup to Done

1. **Ready**: released, unblocked, criteria name proofs.
2. **Build**: a worker claims lease, worktree; submits a PR.
3. **Review**: an independent reviewer approves the exact commit.
4. **Test**: Graphyard observes CI.
5. **Acceptance**: granted producers report proofs its [lane](#risk-lanes) requires.
6. **Done**: Graphyard rechecks gates, merges, observes.

## Shared project memory

Sessions start with a role-scoped digest (≤500 words) of decisions, recurring faults and recent merges, built from applied records (`.graphyard/project-memory.json`; `projectMemory` in `master status`).

## Risk lanes

`src/model/policy.ts` sets a **risk lane** (`low`, `medium`, `high`) by paths; landability requires facts by lane.

- **High** (4 h): `migrations/schema`, `auth/credentials`, `src/store/`, authentication, principals, public API, its assembler, credential bootstrap (`src/server/`), operator agent, proof grants, `src/install/`, `deploy/`, Dockerfile, `compose.yaml`, unobserved changes. Producer proofs, `manual:` attestations, two-party rework.
- **Medium** (60 min): remainder; adds producer-run `unit:`/`integration:`.
- **Low** (30 min): test-only, docs-only, single-module. Required CI, one approval; no producer proofs or `manual:` attestations.

All lanes require `e2e:` proofs; low/medium reworks need no approver (recorded as approved by `graphyard-risk-lane`). Neither does a rework in any lane whose ground the record shows on the exact head: a trusted proof failed on it, an approver refused its `manual:` attestation, or GitHub reports it conflicting (`src/model/rework-ground.ts`). The loop turns a refused attestation into that rework itself, and a rework applied on such a ground is no [intervention](dashboard.md).

## Who holds which authority

![Bootstrap: one supervised worker; normal operation: a fleet.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: in bootstrap the human operator supervises one worker; later the master dispatches many, each with own credential.

![Authority of operator, Graphyard, Herdr sessions, reviewer, producer.](diagrams/roles-and-authority.svg)

Text equivalent: operator makes human-only decisions; Herdr hosts master (`coordinator`), slice lead, worker (epoch, worktree); reviewer, producer hold credentials; guarded path merges. Colours: [legend](glossary.md#diagram-legend).

## Correctness rules

![Control plane: callers, engine, Postgres, reconciliation worker, GitHub.](diagrams/control-plane-components.svg)

Text equivalent: callers use the API; the engine applies mutations with events in locked Postgres transactions; reconciliation syncs GitHub and hands passing heads to GitHub to merge; webhooks wake jobs.

Gates are deterministic checks of one candidate, `(PR, head SHA, base SHA)`; claims bump the epoch; latest trusted proof wins; merge is not [delivery](delivery.md).
