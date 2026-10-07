<!-- page: Start here | 1 | lifecycle, authority. -->
# How Graphyard works

Graphyard decides whether work advances; runtimes (Herdr) run sessions. An item goes Ready (released, unblocked, criteria name proofs) → Build (a worker claims a lease and worktree, submits a PR) → Review (an independent reviewer approves the exact commit) → Test (Graphyard observes CI) → Acceptance (granted producers report the proofs its [lane](#risk-lanes) requires) → Done (gates rechecked, merged, observed). Sessions start with a role-scoped digest of decisions, faults and merges (`.graphyard/project-memory.json`).

## Risk lanes

`src/model/policy.ts` sets a **risk lane** (`low`, `medium`, `high`) by paths:

- **High** (4 h): `migrations/schema`, `auth/credentials`, `src/store/`, `src/server/`, `src/install/`, `deploy/`, Dockerfile, `compose.yaml`, principals, proof grants: producer proofs, `manual:` attestations, two-party rework.
- **Medium** (60 min): the rest; producer-run `unit:`/`integration:`.
- **Low** (30 min): test-only, docs-only, single-module: required CI, one approval.

All lanes require `e2e:` proofs; low/medium reworks need no approver (`graphyard-risk-lane`).

## Who holds which authority

![Bootstrap: one supervised worker; normal operation: a fleet.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: in bootstrap the human operator supervises one worker; later the master dispatches many, each with its own credential.

![Authority of operator, Graphyard, Herdr sessions, reviewer, producer.](diagrams/roles-and-authority.svg)

Text equivalent: the operator makes human-only decisions; Herdr hosts master (`coordinator`), slice lead and worker; reviewer and producer hold credentials. Colours: [legend](glossary.md#diagram-legend).

![Control plane: callers, engine, Postgres, reconciliation worker, GitHub.](diagrams/control-plane-components.svg)

Text equivalent: callers use the API; the engine applies mutations with events in locked Postgres transactions; reconciliation syncs GitHub, which merges passing heads. Gates judge one candidate `(PR, head SHA, base SHA)`; merge is not [delivery](delivery.md).
