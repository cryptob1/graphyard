<!-- page: Start here | 1 | lifecycle and authority. -->
# How Graphyard works

Graphyard decides whether work advances; runtimes such as Herdr run sessions.

## One trip from setup to Done

1. **Ready**: released, unblocked, criteria naming proofs.
2. **Build**: a leased worker submits a PR from its worktree.
3. **Review**: an independent reviewer approves the exact commit.
4. **Test**: Graphyard observes CI.
5. **Acceptance**: granted producers report the [lane](#risk-lanes)'s proofs.
6. **Done**: Graphyard rechecks every gate, merges, observes.

A card stops at its first refusing gate, naming what is missing.

## Shared project memory

Every worker, reviewer and producer starts with a role-filtered project-memory digest in its first request (≤500 words):
- Approved decisions and reasons; operator answers.
- Recurring fault classes and remedies.
- Merges after the base with changed files (last 24 hours when unremembered).

The loop updates memory from applied decisions, human answers, recurring faults and merges—never agent claims—persisting `.graphyard/project-memory.json`. `master status` reports `projectMemory`.

## Risk lanes

`src/model/policy.ts` assigns each item a **risk lane** by changed paths; `master status` shows its p50 target:
- **High** (4 h): schema, persistence, auth, credentials, principals, public API, operator agent, proof grants, install, deploy, unobserved changes. Adds `manual:` attestations and two-party rework decisions.
- **Medium** (60 min): default; adds producer `unit:`/`integration:` proofs.
- **Low** (30 min): test-only, docs-only or single-module; required CI, one approval.

Every lane requires `e2e:` proofs and bootstrap obligations; low and medium reworks need no approver.

## Who holds which authority

![Bootstrap versus normal operation: one supervised worker, then a fleet.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: in bootstrap the human operator supervises one worker while gates activate; then the master dispatches many, each in its own worktree.

![Authority held by the operator, Graphyard, Herdr sessions, reviewer and producer.](diagrams/roles-and-authority.svg)

Text equivalent: the operator sends human-only decisions; Herdr hosts master, slice lead and worker; reviewer and producer hold their own credentials. Colours: [legend](glossary.md#diagram-legend).

## Correctness rules

![Control-plane components: callers, engine, Postgres, reconciliation worker and GitHub.](diagrams/control-plane-components.svg)

Text equivalent: callers use the API; the engine applies each mutation in one locked Postgres transaction; the reconciliation worker syncs GitHub, publishes the check and merges; webhooks only wake jobs.

- Gates are deterministic checks of `(PR, head SHA, base SHA)` under current policy; pushes or base changes void evidence.
- Claims bump epoch; old-epoch or expired-lease commands refuse.
- Evidence belongs to its producer; latest trusted record per proof and candidate wins.
- History is append-only; same-day retries replay.
- Graphyard merges only the exact authorized candidate, once; any other merge is a permanent violation. Merge is not [delivery](delivery.md).
