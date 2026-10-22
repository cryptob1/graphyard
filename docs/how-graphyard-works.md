<!-- page: Start here | 1 | lifecycle -->
# How Graphyard works

Graphyard decides whether work advances; runtimes (Herdr) run sessions.

## One trip to Done

1. **Ready**: released, unblocked, criteria name proofs.
2. **Build**: worker claims lease and worktree, submits the exact commit, pushes nothing.
3. **Review**: independent reviewer approves the exact commit.
4. **Test**: the merge writer trial-merges onto base, runs build and tests.
5. **Acceptance**: granted producers report the [lane](#risk-lanes) proofs.
6. **Done**: Graphyard rechecks gates, pushes base, observes.

## From goal to work items

Goal passes intake, acceptance, planning and delivery. `graphyard goal FILE` records it; acceptance role writes outcomes and required `uat` cases ([validation](validation.md)), landed as drafted. Merged, `planner` role writes a ≤3-sentence `summary`, architecture note (at most 400 words) and items, each naming one-sentence `plain`, outcomes, cases, a plan of files and predecessors; a serving-release criterion carries `manual:post-deploy/NAME` beside a buildable one. A plan leaving outcome uncovered or parallel items sharing file is refused with the reason. Loop creates and releases items (`planned`, then `delivering`), dispatching none before its dependencies are delivered. Goal is `delivered` once every item is done and production serves it.

## Risk lanes

**Risk lane** (`low`/`medium`/`high`) is set by paths.

- **High** (4h): store, auth, server, principals, public API, operator agent, proof grants, install, deploy. Producer proofs, `manual:` attestations.
- **Medium** (60min): remainder.
- **Low** (30min): test-only, docs-only, single-module. Required CI, one approval.

**Risk class** (`sensitive`/`normal`; unknown: sensitive): delta paths vs `graphyard.json` `risk.sensitive` (generic default), in `graphyard status`. **Review timing**: sensitive before merge, normal after unless `review.normalChanges: pre-merge` ([delivery](delivery.md)).

## Who holds which authority

![Bootstrap: one supervised worker; normal operation: a fleet.](diagrams/bootstrap-vs-normal.svg)

Text equivalent: in bootstrap the human operator supervises one worker; later master runs a credentialed fleet.

![Authority of operator, Graphyard, Herdr sessions, reviewer, producer.](diagrams/roles-and-authority.svg)

Text equivalent: operator: goals, money, credentials for people; Herdr hosts master (applies every other decision), slice lead, worker; reviewer, producer hold credentials; guarded path merges. [legend](glossary.md#diagram-legend).

## Correctness rules

![Control plane: callers, engine, Postgres, loop and merge writer, git remote.](diagrams/control-plane-components.svg)

Text equivalent: mutations and events commit in locked transactions; the merge writer trial-merges passing heads and pushes with its deploy key; no webhook is served.

Gates are deterministic checks of one candidate, `(change number, head SHA, base SHA)`; latest trusted proof wins; merge is not [delivery](delivery.md).
