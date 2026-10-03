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

Workers, reviewers and producers get a role-filtered digest (≤500 words) in their first request: decisions and operator answers, recurring faults and remedies, and the last 24 hours' merges with changed files. The loop maintains it in `.graphyard/project-memory.json` (`master status` `projectMemory`).

## Risk lanes

`src/model/policy.ts` assigns each item a **risk lane** by changed paths; `master status` shows its p50 target:
- **High** (4 h): auth, credentials, principals, API, grants, install, deploy, schema. Adds `manual:` attestations and two-party rework decisions.
- **Medium** (60 min): default; adds producer proofs.
- **Low** (30 min): test/docs-only or single-module; required CI, one approval.

Low and medium reworks need no approver.

## Who holds which authority

![Bootstrap versus normal operation: one supervised worker, then a fleet.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: in bootstrap the human operator supervises one worker while gates activate; then the master dispatches many, each in its own worktree.

![Authority held by the operator, Graphyard, Herdr sessions, reviewer and producer.](diagrams/roles-and-authority.svg)

Text equivalent: the operator sends human-only decisions; Herdr hosts master, slice lead and worker; reviewer and producer hold their own credentials ([legend](glossary.md#diagram-legend)).

## Correctness rules

![Control-plane components: callers, engine, Postgres, reconciliation worker and GitHub.](diagrams/control-plane-components.svg)

Text equivalent: callers use the API; the engine applies each mutation in one locked Postgres transaction; the reconciliation worker syncs GitHub, publishes the check and merges; webhooks only wake jobs.

- Gates deterministically check one candidate, `(PR, head SHA, base SHA)`, under the current policy revision; a push or base change invalidates evidence.
- Claims bump the epoch; stale-epoch commands refuse. The latest trusted record per proof and candidate wins.
- Graphyard merges only the exact authorized candidate, once. Merge is not [delivery](delivery.md).
