<!-- page: Start here | 1 | lifecycle, authority. -->
# How Graphyard works

Graphyard decides whether work advances; runtimes (Herdr) run sessions, each starting with role-scoped ≤500-word digest from applied records (`.graphyard/project-memory.json`; `projectMemory` in `master status`).

## One trip from setup to Done

1. **Ready**: released, unblocked, criteria name proofs.
2. **Build**: worker claims lease, worktree; submits PR.
3. **Review**: independent reviewer approves exact commit.
4. **Test**: Graphyard observes CI.
5. **Acceptance**: granted producers report proofs its [lane](#risk-lanes) requires.
6. **Done**: Graphyard rechecks gates, merges, observes.

## From goal to work items

Goal passes intake, acceptance, approval, planning, approval and delivery. `graphyard goal FILE` records it; acceptance role writes outcomes and required `uat` cases ([validation](validation.md)), non-author-approved. Merged, `planner` role writes architecture note (at most 400 words) and items, each naming its outcomes, cases, `plannedFiles` and predecessors; a serving-release criterion carries `manual:post-deploy/NAME` beside a buildable one. A plan leaving outcome uncovered, parallel items sharing file, naming a criterion twice or touching a required case is refused with the reason; three refused rounds hand goal to master. Another identity approves the plan (`goal plan-approve`); loop creates and releases items (`planned`, then `delivering`), dispatching none before its dependencies are delivered. Goal is `delivered` once every item is done and production serves it: merge deployed, smoke proof where policy asks.

An outright 401/403/409/422 refusal redrafts acceptance or re-releases a plan an hour later, noting it; a 422 plan post is a refused round; so is a validation-failed payload: reason fed back as `lastRefusal`, retried in ten minutes; others re-post then. `POST /goals/GY-N/land` fetches the base first (≤20s), else `503` unrecorded.

## Risk lanes

`src/model/policy.ts` sets **risk lane** (`low`, `medium`, `high`) by paths.

- **High** (4h): `migrations/schema`, `auth/credentials`, `src/store/`, authentication, principals, public API, credential bootstrap (`src/server/`), operator agent, proof grants, `src/install/`, `deploy/`, Dockerfile, `compose.yaml`, unobserved changes. Producer proofs, `manual:` attestations, two-party rework.
- **Medium** (60min): remainder; adds producer-run `unit:`/`integration:`.
- **Low** (30min): test-only, docs-only, single-module. Required CI, one approval.

**Risk class** (`sensitive`/`normal`; unknown: sensitive), judged from the merge delta per the repository's `graphyard.json` (`risk.sensitive`, `review.normalChanges`; generic defaults; [delivery](delivery.md)), shows in `graphyard status`; lanes still gate github mode.

All lanes require `e2e:` proofs; low/medium reworks need no approver (`graphyard-risk-lane`), nor any lane's rework grounded on the exact head: trusted proof failed on it, approver refused its `manual:` attestation (loop-requested), or control plane's own test merge onto moved base conflicted (not GitHub's reading alone; `src/model/rework-ground.ts`). A returned head has spent its ground (a later retry-cap rework waits). Grounded reworks are no [intervention](dashboard.md).

## Who holds which authority

![Bootstrap: one supervised worker; normal operation: a fleet.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: in bootstrap the operator supervises one worker; later master runs a credentialed fleet.

![Authority of operator, Graphyard, Herdr sessions, reviewer, producer.](diagrams/roles-and-authority.svg)

Text equivalent: operator makes human-only decisions; Herdr hosts master (`coordinator`), slice lead, worker; reviewer, producer hold credentials; guarded path merges. [legend](glossary.md#diagram-legend).

## Correctness rules

![Control plane: callers, engine, Postgres, reconciliation worker, GitHub.](diagrams/control-plane-components.svg)

Text equivalent: mutations, events commit in locked Postgres transactions; reconciliation syncs GitHub, merging passing heads; webhooks wake jobs.

Gates are deterministic checks of one candidate, `(PR, head SHA, base SHA)`; claims bump epoch; latest trusted proof wins; merge is not [delivery](delivery.md).
