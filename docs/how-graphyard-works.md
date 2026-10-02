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

Cards stop at the first refusing gate, naming what's missing.

## Risk lanes

`src/model/policy.ts` assigns a **risk lane** (`low`, `medium`, `high`) by changed paths; the landability verdict requires facts by lane.

- **High** (4 h): `migrations/schema`, `auth/credentials`, `src/store/`, authentication, principals, public API, its assembler, credential-loading bootstrap (`src/server/`), operator agent, proof grants, `src/install/`, `deploy/`, Dockerfile, `compose.yaml`, unobserved changes. Producer proofs, `manual:` attestations, two-party rework decisions.
- **Medium** (60 min): the rest; adds producer-run `unit:`/`integration:`.
- **Low** (30 min): test-only, docs-only, single-module (shared leading segments). Required CI, one approval; no producer proofs or `manual:` attestations.

All lanes require `e2e:` proofs; low/medium reworks need no approver.

## Who holds which authority

![Bootstrap: one supervised worker; normal operation: a fleet.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: in bootstrap the human operator supervises one worker; later the master dispatches many, each own credential, worktree.

![Authority of operator, Graphyard, Herdr sessions, reviewer, producer.](diagrams/roles-and-authority.svg)

Text equivalent: operator makes human-only decisions; Herdr hosts master (`coordinator`), slice lead, worker (epoch, worktree); reviewer, producer hold own credentials; merges only via the guarded path. Colours: [legend](glossary.md#diagram-legend).

## Correctness rules

![Control plane: callers, engine, Postgres, reconciliation worker, GitHub.](diagrams/control-plane-components.svg)

Text equivalent: callers use the API; the engine applies each mutation, with an event, in one locked Postgres transaction; reconciliation syncs GitHub, publishes the required check, merges; webhooks only wake jobs.

- Gates are deterministic checks of one candidate, `(PR, head SHA, base SHA)`, under the current policy revision; pushes, base changes invalidate evidence.
- Claims bump the epoch; old-epoch or expired-lease commands refuse.
- Evidence is its authenticated producer's; latest trusted record per proof and candidate wins, even failing.
- Append-only history; retries within a day replay.
- Graphyard merges only the exact authorized candidate, once (else a permanent violation); merge isn't [delivery](delivery.md).
