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

Workers, reviewers and producers start with a role-scoped memory digest (<=500 words): approved decisions, answered requests, recurring fault classes with remedies, merges to main since base (or 24h) with files. Updated from applied decisions, human answers, fault classes, merges (never agent claims), kept in cursor and `.graphyard/project-memory.json`. `master status` reports `projectMemory`; on Workers page.

## Risk lanes

`src/model/policy.ts` sets a **risk lane** (`low`, `medium`, `high`) by paths; landability requires facts by lane.

- **High** (4 h): `migrations/schema`, `auth/credentials`, `src/store/`, authentication, principals, public API, its assembler, credential bootstrap (`src/server/`), operator agent, proof grants, `src/install/`, `deploy/`, Dockerfile, `compose.yaml`, unobserved changes. Producer proofs, `manual:` attestations, two-party rework.
- **Medium** (60 min): remainder; adds producer-run `unit:`/`integration:`.
- **Low** (30 min): test-only, docs-only, single-module. Required CI, one approval; no producer proofs or `manual:` attestations.

All lanes require `e2e:` proofs; low/medium reworks need no approver.

## Who holds which authority

![Bootstrap: one supervised worker; normal operation: a fleet.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: in bootstrap the human operator supervises one worker; later the master dispatches many, each own credential, worktree.

![Authority of operator, Graphyard, Herdr sessions, reviewer, producer.](diagrams/roles-and-authority.svg)

Text equivalent: operator makes human-only decisions; Herdr hosts master (`coordinator`), slice lead, worker (epoch, worktree); reviewer, producer hold own credentials; merges only via the guarded path. Colours: [legend](glossary.md#diagram-legend).

## Correctness rules

![Control plane: callers, engine, Postgres, reconciliation worker, GitHub.](diagrams/control-plane-components.svg)

Text equivalent: callers use the API; the engine applies mutations with events in locked Postgres transactions; reconciliation syncs GitHub, publishes the required check, merges; webhooks wake jobs.

- Gates are deterministic checks of one candidate, `(PR, head SHA, base SHA)`, under current policy; pushes/base changes invalidate evidence.
- Claims bump the epoch; old-epoch or expired-lease commands refuse.
- Evidence belongs to its producer; latest trusted record per proof/candidate wins.
- Append-only history; retries replay 24h.
- Graphyard merges only the authorized candidate; merge is not [delivery](delivery.md).
