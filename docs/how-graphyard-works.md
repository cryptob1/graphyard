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

## Risk lanes

`src/model/policy.ts` puts each item in a **risk lane** by changed paths (renames by both endpoints), setting what landing requires; `master status` shows its p50 target.

- **High** (4 h): schema, persistence, auth, credentials, principals, public API, operator agent, proof grants, install, deploy, unobserved changes. Adds `manual:` attestations and a two-party decision per rework.
- **Medium** (60 min): the rest; adds producer-run `unit:`/`integration:` proofs.
- **Low** (30 min): test-only, docs-only or single-module: required CI, one approval.

Every lane requires `e2e:` proofs and inherited bootstrap obligations; low and medium reworks need no approver (`graphyard-risk-lane`).

## Who holds which authority

![Bootstrap versus normal operation: one supervised worker, then a fleet.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: in bootstrap the operator supervises one worker while gates activate; then the master dispatches many, each credentialed, in its own worktree.

![Authority held by the operator, Graphyard, Herdr sessions, reviewer and producer.](diagrams/roles-and-authority.svg)

Text equivalent: the operator sends human-only decisions; Herdr hosts master, slice lead and worker; reviewer and producer hold own credentials; merges are guarded. Colours follow the [legend](glossary.md#diagram-legend).

## Correctness rules

![Control-plane components: callers, engine, Postgres, reconciliation worker and GitHub.](diagrams/control-plane-components.svg)

Text equivalent: callers use the API; the engine applies each mutation in one locked Postgres transaction; the reconciliation worker syncs GitHub, publishes the check and merges; webhooks only wake jobs.

- Gates deterministically check one candidate, `(PR, head SHA, base SHA)`, under the current policy revision; a push or base change voids evidence.
- Each claim bumps the epoch; old-epoch or expired-lease commands refuse.
- Evidence belongs to its producer; the latest trusted record per proof and candidate wins, even a failure.
- History is append-only (routine rows compacted after retention); a retry within a day replays.
- Graphyard merges only the exact authorized candidate, once; any other merge is a permanent violation. Merge is not [delivery](delivery.md).
