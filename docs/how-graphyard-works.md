<!-- page: Start here | 1 | lifecycle, authority. -->
# How Graphyard works

Graphyard decides whether work advances; runtimes (Herdr) run sessions, each starting with a role-scoped digest (≤500 words) of decisions, recurring faults and recent merges from applied records (`.graphyard/project-memory.json`; `projectMemory` in `master status`).

## One trip from setup to Done

1. **Ready**: released, unblocked, criteria name proofs.
2. **Build**: a worker claims lease, worktree; submits a PR.
3. **Review**: an independent reviewer approves the exact commit.
4. **Test**: Graphyard observes CI.
5. **Acceptance**: granted producers report proofs its [lane](#risk-lanes) requires.
6. **Done**: Graphyard rechecks gates, merges, observes.

## Risk lanes

`src/model/policy.ts` sets **risk lane** (`low`, `medium`, `high`) by paths.

- **High** (4 h): `migrations/schema`, `auth/credentials`, `src/store/`, authentication, principals, public API and its assembler, credential bootstrap (`src/server/`), operator agent, proof grants, `src/install/`, `deploy/`, Dockerfile, `compose.yaml`, unobserved changes. Producer proofs, `manual:` attestations, two-party rework.
- **Medium** (60 min): remainder; adds producer-run `unit:`/`integration:`.
- **Low** (30 min): test-only, docs-only, single-module. Required CI and one approval only.

All lanes require `e2e:` proofs; low/medium reworks need no approver (approved by `graphyard-risk-lane`).

## Who holds which authority

![Bootstrap: one supervised worker; normal operation: a fleet.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: in bootstrap the human operator supervises one worker; later the master dispatches many, each credentialed.

![Authority of operator, Graphyard, Herdr sessions, reviewer, producer.](diagrams/roles-and-authority.svg)

Text equivalent: operator makes human-only decisions; Herdr hosts master (`coordinator`), slice lead, worker (epoch, worktree); reviewer, producer hold credentials; guarded path merges. Colours: [legend](glossary.md#diagram-legend).

## Correctness rules

![Control plane: callers, engine, Postgres, reconciliation worker, GitHub.](diagrams/control-plane-components.svg)

Text equivalent: API callers' mutations apply with events in locked Postgres transactions; reconciliation syncs GitHub, which merges passing heads; webhooks wake jobs.

Gates are deterministic checks of one candidate, `(PR, head SHA, base SHA)`; claims bump epoch; latest trusted proof wins; merge is not [delivery](delivery.md).
