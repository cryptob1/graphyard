# Huck Engineer investigation: lessons for Graphyard

> **Historical research.** Commit references and implementation status below are preserved for context. Use the [current documentation index](../README.md) for shipped behavior.

Huck Engineer is a QA and delivery system built around one product ecosystem. Graphyard is a runtime-independent coordination and authorization system. Their strongest capabilities are complementary.

**Graphyard should retain its ownership, identity, and evidence-trust model, then add deployed-behavior validation and release observability.** Adopting Huck Engineer's architecture wholesale would introduce product-specific coupling and weaker authority boundaries.

## Scope, provenance, and confidence

This investigation examined source, schemas, workflow scripts, tests, contributor instructions, and product documentation. It did not execute tests, access production data or credentials, or certify either live deployment.

Pinned baselines:

| System | Inspected baseline | Treatment |
| --- | --- | --- |
| Huck Engineer | `6d5fa5d2aaee4daef52ebde6381d7383bfdda39f` | Source snapshot underlying this comparison |
| Graphyard main | `d3515191f2f74c2d8b4e7a2c4c31be67aead7edc` | Implemented baseline; not a claim about future merged changes |
| Graphyard pending work | PRs #3–#6 | Herdr onboarding, dashboard/session fixes, worker labels, and an experimental Codex review adapter; separate from baseline main |

The pending Codex adapter was inspected on its feature branch. It is not used to claim that a deployed cloud approval round-trip already works. The other pending changes are noted as planned gap reductions, not independently certified here.

References use repository-relative paths and line anchors from the pinned baselines. Huck references identify inspected implementation without reproducing proprietary source or linking to private deployments. The underlying source is not included in this public report; readers without access cannot independently reproduce the Huck inspection from these references alone. Operational identifiers, customer examples, private URLs, and source excerpts have been omitted.

Confidence is high in the inspected architecture and concrete code paths, moderate in completeness across the larger Huck application, and unverified for current production behavior and fleet-scale performance. Existing tests indicate intended coverage, not successful execution during this investigation. Some comments describe historical limitations subsequently addressed by newer code; findings favor implementation over those comments.

## Architecture and product boundary

Huck Engineer combines a work tracker, a test catalog, an application-driving runner, a delivery pipeline dashboard, and operational analytics. Its catalog contains case data with executable oracle definitions. Its runner exercises product channels and checks authoritative outcomes. Its pipeline joins work obligations, validation queues, workflow activity, release ranges, and deployed services.

The implementation is a TypeScript/pnpm monorepo with a Next.js application, Postgres/Drizzle schemas, shared contracts, and a separate runner package. Graphyard is a smaller coordination service with independently authenticated principals, transactional ownership, deterministic gates, immutable history, and external integrations.

Sources: Huck `README.md:1`, `README.md:111`, `packages/runner/src/orchestrator.ts:302`, `apps/web/src/lib/pipeline.ts:397`; Graphyard `src/engine.ts:24`, `src/store.ts:35`.

| Area | Huck Engineer implementation | Graphyard baseline | Implication |
| --- | --- | --- | --- |
| Worker authority | API-key authentication with caller-supplied actor fields; operational agent identity also relies on coordination conventions | Authenticated principals, atomic claims, lease epochs, workspace reservations | Preserve Graphyard's stronger machine-enforced authority |
| Delivery lifecycle | Product staging validation, promotion and production conditions; distinct tracker release path | Historically authorized observed merge completes work | Environments and releases are the largest functional gap |
| Acceptance | Structured case/unit/detector proofs, measured feeds, stage obligations, revisions and deferrals | Required proof names, head/base/policy binding, immutable task requirements | Improve proof selection and revisions without weakening trust |
| E2E catalog | Repository case files, schema validation, deployment synchronization, runner specifications | Immutable scenario versions, hashes and environment requirements; executable source remains external | Retain pinned definitions; add runner dispatch and result ingestion |
| E2E execution | Batches, channel executors, authoritative oracles, retries and blocked/flaky results | No general automatic E2E orchestration | Add an external-runner protocol rather than a product-specific harness |
| Release attribution | Range sweeps, served-commit observations, work release records, stranded-work revisits | PR/head/base/merge evidence and durable GitHub jobs | Add release membership and catch-up reconciliation |
| Runtime health | Expected manifests, version agreement, freshness, rollout grace, superseded releases | Scenario environment labels | Separate desired deployment from observed runtime |
| Pipeline UX | Waiting versus failing validation, lanes, stalls, release membership, merged-but-unadvanced work | First refusing gate and current-stage visibility | Expand operational diagnosis beyond counts |
| Evidence analytics | Artifacts, attempt history, replay coverage and costs | Small proof records with URLs | Enrich evidence incrementally |
| Code review | A work review stage does not itself establish independent agent approval | Current-head GitHub approval; experimental cloud adapter pending | Continue dedicated, authenticated provider adapters |

## Transferable findings

### 1. Prove behavior through authoritative outcomes

Huck's runner does more than ask an agent whether a scenario passed. It evaluates command history, server state, and business outcomes. An oracle without executable conditions refuses to determine a pass.

Sources: Huck `packages/runner/src/oracle.ts:95` (server state), `:155` (business outcomes), `:288` (oracle evaluation), `:305` (empty-oracle refusal); `packages/runner/src/worker.ts:155`; `apps/web/tests/oracle-state-gate.test.ts`.

Graphyard should let a criterion select a proof definition identifying the runner, scenario or test, required checks, target identity, and resulting artifact. A planning agent may propose that mapping; it must not authorize its own evidence.

For example, a requirement that confirmation triggers exactly one notification needs execution plus an authoritative observation of exactly one effect. A screenshot, green suite, or implementation assertion must not silently substitute for that observation.

### 2. Distinguish unmeasured from failed

Huck's CI wrapper discovers test files independently of Vitest selection and reconciles them with the runner report. Missing files, empty reports, pending tests, inconsistent totals, and changes to inventoried files fail the check. Unique report paths prevent a prior successful report from standing in for the current execution.

Sources: Huck `scripts/ci-test.mjs:7`, `:20`, `:68`, `:76`; `scripts/ci-test.test.mjs`.

Graphyard already has a trusted acceptance contract with an explicit inventory of coordination checks: `scripts/acceptance-contract.mjs:4` and `scripts/publish-acceptance.mjs:5`. The gap is generalization, not a total absence of inventory validation.

Extend trusted reporters to supported test formats and requirement-specific checks. Keep “the measurement did not happen” distinct from “the measured behavior failed.” Inventory reconciliation still cannot prove that the tests express correct product intent.

### 3. Derive requirement satisfaction from evidence

Huck represents structured proof kinds and has measured feeds for matching criteria. Current code includes unit and detector feeds even though nearby older comments say those feeds are future work. Case acceptance also updates matching criteria in a transaction.

Sources: Huck `apps/web/src/lib/work.ts:117`, `:278`, `:1201`; `apps/web/src/lib/work-measured-proofs.ts:84`; `apps/web/src/lib/work-measured-feed.ts:84`, `:97`; `apps/web/src/lib/work-validation.ts:453`; `apps/web/tests/work-measured-feed-db.test.ts`.

Graphyard should support explicit requirement revisions with stable criterion IDs, actor-derived authorization, a reason, full history, and recomputation of evidence applicability. Preserve admissible evidence as the source of satisfaction rather than copying mutable completion ticks as the final authority.

Requirement revisions must be a separately authorized operation. They must not become an implementation worker's route around a failing requirement.

### 4. Attribute each validation run to one target

Huck observes the deployed target version before and after E2E execution. A changed target or mismatch with the expected commit prevents clean attribution. Executed results can be retained while recording the attribution failure.

Sources: Huck `packages/runner/src/target-version.ts:3`, `:25`, `:40`; `packages/runner/src/target-version.test.ts`.

A Graphyard validation run should identify the requested candidate, actual build or artifact, environment instance, scenario revision, runner identity, and versions observed before and after execution. A release during the run should yield an explicit attribution failure, not a misleading pass or a missing run.

### 5. Shared staging can make strict evidence impossible to finish

A shared staging branch can advance faster than E2E runs complete. Invalidating every result on every unrelated merge can make a gate individually correct yet operationally impossible to satisfy.

Huck addresses this with compatible content fingerprints, falling back to exact SHA equality when fingerprints are absent. The latest compatible result must be a pass: a later blocked result does not restore health.

Source: Huck `apps/web/src/lib/work-gates.ts:529` through the compatibility and latest-result checks at `:572`.

Graphyard should first use immutable preview builds or pinned release candidates and explain invalidation visibly. Consider scoped evidence reuse only after that delivery path works.

Do not immediately replace exact version binding with file-overlap heuristics. A sound fingerprint must cover transitive dependencies, lockfiles, build inputs, configuration, migrations, and relevant services. Missing scope could reuse evidence after behavior changes. Git ancestry alone is insufficient: a later revert may contain the original commit while removing its behavior.

### 6. Reconcile release ranges, not only triggering commits

Huck's release recorder handles workflow coalescing and deployments that skip intermediate commits. It sweeps from a previous successful anchor to the commit actually served, records included work, and revisits work that previously refused advancement.

Sources: Huck `scripts/record-release-sweep.mjs:3`, `:50`, `:136`; `scripts/record-release-advance.mjs`; `.github/workflows/record-release.yml`; corresponding sweep and advance tests.

Graphyard needs explicit release membership and catch-up reconciliation for work whose individual event or workflow run was lost. Use durable cursors, idempotent records, bounded retries, and visible partial failures. A sweep limit needs continuation; it must not silently mark omitted history reconciled.

Implement this using Graphyard's existing durable jobs. A second independently authoritative queue would recreate the coordination problem.

### 7. Observe what services run

Huck compares expected services with runtime manifests. It distinguishes pending rollout, confirmed deployment, stale reports, disagreements, and a newer release superseding the inspected release.

Sources: Huck `apps/web/src/lib/release-environment.ts:50`, `:86`, `:107`, `:171`, `:201`; `apps/web/tests/release-environment.test.ts`.

Graphyard should add first-class environments, releases, deployment observations, and expected-service configuration. Separate deployment time, runtime-report time, and receipt time: a late observation does not mean a late deployment.

Huck's concrete service lists and provider/model checks are application-specific. Graphyard should expose adapter contracts and configurable invariants, not embed those lists.

### 8. Diagnose why work is stuck

Huck derives waiting validation from current gates, distinguishes failing from not-yet-run work, exposes lanes and old waits, and identifies merged or deployed work that has not advanced.

Sources: Huck `apps/web/src/lib/pipeline.ts:124`, `:143`, `:230`, `:638`, `:687`, `:1096`; `apps/web/src/lib/pipeline-gates.ts`; pipeline unit and UI tests.

Graphyard should surface actionable classifications: waiting for capacity, unacknowledged dispatch, missing heartbeat, failed behavior, missing evidence, stale candidate, partial deployment, unauthorized merge, and delivered artifact with unresolved work.

Disconnected or unobserved systems must not appear empty or healthy. The pending dashboard/session fixes address part of this UX principle; they do not implement these broader operational classifications.

### 9. Preserve attempts and artifacts

Huck retains retry history, labels a passing retry flaky, distinguishes transient environmental blocks from product failures, and avoids retrying every timeout or permanent failure. Required evidence that could not be stored remains a proof problem even when behavior appeared to pass.

Sources: Huck `packages/runner/src/orchestrator.ts:60`, `:78`, `:97`, `:132`; `packages/shared/src/evidence-artifacts.ts:25`, `:56`.

Graphyard evidence should grow to include attempt identity, execution status, attribution status, artifact hashes and availability, and sanitized failure categories. A retry must preserve the earlier failure rather than replacing history with the winning attempt.

### 10. Replay retained evidence with explicit coverage

Huck can rerun deterministic detectors over retained reports and report how much required signal exists. This enables inexpensive regression investigation without repeatedly exercising live systems.

Sources: Huck `apps/web/src/lib/corpus-replay.ts:5`, `:53`; `apps/web/tests/corpus-replay.test.ts`.

Graphyard could eventually replay verifiers against sanitized retained artifacts. Zero findings must include coverage and instrumentation availability. Offline replay does not establish that a current deployment works; live-state-dependent oracles remain a different kind of proof.

## What Graphyard should not copy

### Shared-key actor assertions

Huck's transition route authenticates an API key and accepts actor fields in the request. This supports its operational trust arrangement but does not provide independently authenticated worker identity or lease fencing.

Sources: Huck `apps/web/src/lib/api-key.ts:6`, `apps/web/src/app/api/work/[key]/transition/route.ts:7`, `apps/web/src/lib/work.ts:263`; Graphyard `src/model.ts:57`, `src/engine.ts:64`, `src/engine.ts:90`.

Preserve Graphyard's principal-derived authority, separate producer credentials, and epoch checks. Display names and operator conventions are not authorization.

### Product-specific lifecycle inference

Huck has normal, hotfix, documentation, presentation, invariant, tracker-repository, and no-artifact paths. Some distinctions use repository URLs and absent artifact fields.

Sources: Huck `apps/web/src/lib/work-gates.ts:43`, `:108`, `:128`, `:151`.

Generic Graphyard should use explicit, validated delivery profiles. A missing PR must not accidentally prove that no artifact ships. Likewise, Graphyard's own runtime changes should not be treated as documentation merely because a product-specific test harness cannot exercise them.

### Waivers as worker shortcuts

Huck supports expiring promotion waivers and audited criterion deferrals. These demonstrate a real need for explicit exception handling, not permission for an implementation agent to clear its own gates.

Sources: Huck `apps/web/src/lib/work-gates.ts:577`, `apps/web/src/lib/work.ts:271`.

If Graphyard adds exceptions, require separately authorized scope, expiry, rationale, affected requirement revision, visible residual risk, and a linked follow-up. Deferred must remain distinct from passed. This report does not authorize exceptions for current work.

### A bundled general agent runtime

Huck's channel executors, backend clients, seeded identities, and domain oracles are useful integration implementations. They should not become Graphyard's generic core. Herdr remains responsible for agent execution; Graphyard owns durable assignment, evidence admissibility, and progression.

## Prioritized, bounded roadmap

### P0: Complete current delivery and prove fleet coordination

Finish pending onboarding, dashboard, assignment display, and cloud-review work through real review and validation. Then run a two-host trial.

Acceptance checks:

- Competing claims yield one active owner.
- Expired ownership can be recovered with a new epoch.
- Stale epochs and wrong-host handoffs refuse.
- A partitioned worker cannot regain authority by reconnecting with its old lease.
- Delayed and duplicate provider events converge without losing newer work.
- A pushed commit invalidates the earlier review decision.

This trial should state the remaining boundary: Graphyard cannot revoke arbitrary filesystem or Git credentials merely by expiring a lease.

### P1: Deliver one immutable candidate through external validation

Build a narrow slice: environment definitions, expected services, a pinned candidate, durable validation request and ACK, one external runner adapter, trusted attributable results, production observation, release membership, and catch-up reconciliation.

Acceptance checks:

- A mixed deployment does not pass verification.
- A target changing during a run does not receive valid candidate evidence.
- A dropped event is recovered by reconciliation.
- A duplicate result does not advance twice.
- Missing required artifacts prevent acceptance.
- A newer deployed release is distinguished from an unhealthy older release.

### P2: Improve proof configuration and revise requirements safely

Add proof selection, previews of required evidence, supported report adapters, and explicit criterion revisions.

Acceptance checks:

- Requirements identify what constitutes proof before implementation.
- Revision preserves historical criteria and decisions.
- Only evidence whose applicability changes is invalidated.
- A worker cannot alter requirements to pass its own task.
- Unknown or inconsistent reports remain unmeasured, not passed.

### P3: Diagnose stalls and control shared resources

Add runner capacity, dispatch stalls, orphan detection, resource leases, historical dwell, retry reasons, and backpressure. Treat shared test-resource conflicts separately from source ownership.

Acceptance checks:

- Idle capacity with queued work produces an actionable stall.
- Missing runner heartbeats trigger recovery without duplicate authority.
- A later wakeup survives acknowledgment of an earlier job.
- Unknown connectivity never appears as an empty healthy queue.

### P4: Reuse evidence and improve diagnostics

After pinned-candidate delivery works, assess compatible-content fingerprints, verifier replay, artifact retention, and cost analytics.

Acceptance checks:

- Dependency or configuration changes invalidate relevant evidence.
- Missing scope falls back to stricter binding.
- Later compatible failures remain visible and block reuse.
- Replay reports coverage and cannot claim live deployment verification.
- Exported artifacts follow explicit redaction and retention rules.

## Limits and open questions

This inspection did not establish a general transactional rollback controller, independent agent-review approval protocol, or fleet ownership system in Huck Engineer comparable to Graphyard's leases. Absence from the inspected paths is not proof that no related implementation exists elsewhere.

It also did not establish present production correctness for either system. Live operator journeys, deployment reconciliation, performance, and recovery drills require separate validation. No new framework such as Temporal or a graph-based agent runtime is justified by this comparison alone; the proposed slice can build on Graphyard's current durable coordination model and be reassessed against measured operational needs.

Graphyard must coordinate both who may change code and how the resulting behavior is demonstrated and delivered. Its foundation fits the first problem. Huck Engineer provides concrete lessons for completing the second while retaining Graphyard's stronger authority boundary.
