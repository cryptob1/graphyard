<!-- page: Understand or contribute | 3 | planned work, clearly separated from shipped behavior. -->
# Turnkey E2E execution and verified delivery

**Status: implementation roadmap, not shipped functionality.** Graphyard should eventually cover the full journey from work assignment to independently verified delivery after a guided setup. Users should not have to assemble their own control plane, dispatch queue, evidence broker and deployment reconciler.

The current product stores versioned test-case definitions and accepts separately trusted evidence. It does not yet automatically execute those cases or verify production delivery. The immediate coordination improvements are tracked in GY-14; this roadmap is GY-15. The real two-host Herdr exercise remains GY-2 and is not established by unit tests or this document.

## Product promise and boundary

Graphyard will discover supported repository and deployment infrastructure, propose an explicit delivery profile, configure supported adapters, dispatch required validation, collect results and explain every refusal. A user provides access, selects the environments and reviews the proposed proof mapping. They should not have to implement queue plumbing for a supported stack.

Herdr and other agent runtimes still execute coding sessions. GitHub and deployment platforms still own their external facts. Test code and application-specific assertions stay in Git. Graphyard provides a runner protocol, supported runner packages and orchestration; it need not embed a general coding-agent runtime or understand every application's business domain.

A repository with existing Playwright tests should be able to connect them through guided setup. A repository without tests needs scenarios and executable assertions created first. A planning agent can propose these, but the product must not manufacture passing evidence or present inferred acceptance criteria as independently verified requirements.

Delivery profiles will be explicit:

- **Through merge:** a verified, authorized merge completes the configured workflow.
- **Preview validation:** a pinned preview artifact plus required behavioral proof is the completion boundary.
- **Production verification:** expected artifacts are independently observed across required production services and required checks pass.

Use precise labels in the UI. A green merge must never silently stand in for verified production behavior. Existing completed work keeps its recorded completion meaning; migration does not rewrite delivery history.

## Implementation sequence

| Increment | Outcome | Depends on |
| --- | --- | --- |
| D1 | Immutable candidates, environments and runner protocol | Existing ledger, identity and durable jobs |
| D2 | One supported runner works from guided setup to trusted results | D1 |
| D3 | Deployment observations, release membership and production verification | D1; D2 for behavioral checks |
| D4 | Capacity, recovery, artifact operations and safe rollback integrations | D2–D3 |
| D5 | Additional runner/report adapters and off-the-shelf packaging | Proven D2 path |
| D6 | Optional evidence replay, safe reuse and cost analytics | Stable artifacts and operational measurements |

Implement one vertical path before building an extensible framework around imagined adapters. The initial target is one repository, GitHub, an existing Playwright suite, a pinned preview or staging candidate, and Railway deployment observations. Other supported stacks follow the same protocol. No new workflow framework is required by this plan; reassess if measured operational requirements exceed the existing durable job model.

## D1 — Candidate identity and durable validation requests

Add first-class `Environment`, `ReleaseCandidate`, `ValidationRequest`, `ValidationAttempt` and trusted runner registration. A candidate must identify source and built artifacts, including service membership when multiple services ship together. An environment name is not an immutable target identity.

Creation/revision of environments, candidates, validation requests, oracle approvals and runner/collector registrations is an authority boundary. Only an operator or explicitly delegated policy principal with repository/environment scope may perform it; derive identity and scope from authentication, never request fields. In one transaction, check the expected configuration generation and any delegated lease epoch, validate against current independently observed work/source, requirements and selected delivery profile, append history and publish an immutable version/selection. Derive required proofs, scenario/bundle pins and allowed targets from that authorized state rather than client-selected substitutes. Stale generations, reduced proof coverage or unapproved targets refuse. Implementation workers may request scheduling of already-authorized validation through their current work lease; they cannot define trusted authority. No client-controlled lifecycle state is accepted.

Each request pins:

- Work item and requirement revision, scenario ID/revision/hash, required proof names.
- Independently approved executable test/oracle bundle identity and digest, including its transitive helpers, fixtures, configuration, lockfiles and runner image/version.
- Repository and full head/base source identity, immutable artifact digest or provider build ID.
- Target environment and concrete environment instance or deployment.
- Expected services/configuration identity where behavior depends on them.
- Allowed runner identity, adapter version, deadline and artifact requirements.

Candidate declarations do not establish source-to-artifact provenance. Require a build attestation from an authenticated, authorized build producer, or an independently verified provider mapping, binding the repository, full source identity, declared build inputs and immutable output digest. Verify issuer scope and integrity before accepting that relationship; implementation workers cannot attest their own artifacts. A provider build ID is usable only when its immutable contents and this provenance can be resolved. Unknown or conflicting provenance refuses candidate validation and delivery rather than trusting a SHA supplied alongside a digest.

The request lifecycle separates queued, dispatched, acknowledged, running, completed, cancelled and expired. A dispatch success is not an acknowledgment. Attempts have distinct IDs, lease epochs and idempotency keys. Late results remain auditable but cannot revive superseded authority or advance a different candidate. Cancellation does not assert that an external process has physically stopped.

Runner and collector registrations have revocable authorization generations separate from immutable version history. Bind each attempt to both current registrations and check authenticated principal, scope, active generation and attempt epoch transactionally at dispatch, ACK, heartbeat and result ingestion. Rotation, revocation or scope reduction advances authorization generation and invalidates outstanding authority atomically; late results remain non-authoritative audit. Immutable request pins do not preserve revoked trust. Revocation does not assert physical termination, so execution-resource barriers remain until external fencing or verified settlement makes reassignment safe.

Reuse the transactional ledger and durable jobs for scheduling. Perform provider and runner I/O outside coordination transactions. Define per-adapter idempotency behavior before enabling retries of external side effects.

Acceptance checks:

- Unauthorized creation/revision of environments, candidates, requests, oracle approvals or trusted registrations fails. Stale configuration/delegate epochs and client-selected weakened proof/target substitutions fail without changing authoritative state.
- Duplicate dispatch and duplicate results do not create duplicate authoritative execution or progression.
- A runner that never acknowledges produces a visible timeout and recoverable request.
- Results from a wrong runner, expired epoch, old requirement revision or different artifact do not count.
- Revoking/rotating a runner or collector between dispatch and result ingestion invalidates that attempt authority across replicas; racing results cannot bypass the registration generation check.
- Restarting the server preserves queued requests and observed attempt history.
- Failure to identify the deployed target refuses attributable success.
- An artifact with no trusted source/build-input mapping, a forged attestation or a mismatched output digest cannot authorize validation or delivery.

## D2 — One turnkey Playwright path

*Shipped. See [runner setup](runner-setup.md) for the packaged runner and collector, and [validation](validation.md) for the protocol they speak. The requirements below remain the standard this path is held to; the acceptance checks at the end of this section are the ones it must keep passing.*

Ship a supported runner integration and setup flow, not merely a protocol document. Start by discovering repository configuration and enumerating proposed tests. Let the operator review required scenarios, test inventory, target URL and proof mapping. An independently approved, digest-pinned test/oracle bundle is the executable authority; discovered package names and candidate-controlled commands are only suggestions. The runner verifies the bytes of the approved bundle, including transitive test helpers, fixtures, configuration, lockfiles and runner image/version, before execution. Execute that content-addressed bundle from a read-only boundary inaccessible to candidate-controlled build/setup/test-target processes for the entire attempt, with separately isolated scratch/output paths. Candidate code cannot replace imports, configuration, interpreters or approved runtime dependencies after verification; no shared writable filesystem or candidate-selected module/search path may supply executable oracle bytes. Validate these isolation properties in the supported adapter. It must not silently substitute tests from the implementation checkout. New or changed executable assertions require separately authorized bundle approval and an explicit scenario/requirement revision that pins that bundle; implementation-worker credentials cannot authorize this revision. The approved harness exercises the candidate artifact, so test authority remains separate from the product code under test.

The runner should support an isolated self-hosted execution path and an existing CI execution path. Candidate code must not receive operator credentials or a generic trusted producer token. Separate test execution from the trusted collector that verifies request identity, test inventory, target attribution and artifacts. Scope any execution capability to one request/attempt. The collector must not treat arbitrary candidate-authored JSON as proof that a command ran or that the complete inventory executed.

Isolation must suit untrusted repository code: separate tenants/repositories, fresh workspaces, controlled network access, bounded time/resources and no ambient deployment credentials. A container alone is not a claim of sufficient hostile-code isolation. Specify and test the actual sandbox boundary for each executor. Test accounts and outbound side effects require explicit configuration; do not silently exercise production messaging or payment operations.

D2 includes execution-scoped leases for protected test accounts and environments before its first runner is enabled. Acquire reservations transactionally using authenticated runner identity, registration generation and attempt epoch; grant no conflicting execution. Timeout, cancellation, revocation or a lost heartbeat cannot by itself release a resource. Reassignment requires downstream fencing that prevents prior mutations or independently verified process/operation settlement; unknown outcomes keep the barrier closed and visible. The adapter must demonstrate this boundary under partitions and restarts. If it cannot fence a shared resource, use a fresh isolated resource with no overlap or refuse dispatch. D1 supplies the durable attempt/reservation authority; D2 implements and verifies external enforcement.

D2 includes baseline artifact protection from its first release: durable private storage, authenticated repository/request-scoped access, content hashes, bounded retention with tested deletion, and collection-time redaction or exclusion of sensitive material. Trace bundles and screenshots can contain credentials and customer data; neither a public PR link nor possession of an artifact ID grants access. Use approved test accounts/data and disable artifact capture that cannot meet the configured protection policy. Missing required artifacts then refuse acceptance instead of uploading unsafe evidence. Document the default persistent-storage configuration for Docker and Railway, including storage credentials available only to the collector, and fail setup if it is absent. Record artifact expiry explicitly without rewriting historical authorization; expired artifacts cannot satisfy gates that require current availability.

Require an immutable target for the first supported runner path. Before-and-after identity checks are additional diagnostics, not sufficient proof of continuous attribution: an A → B → A rollout could evade both. If a later adapter supports mutable targets, it must correlate every tested request with artifact identity or provide complete, gap-detecting deployment/instance history covering the entire execution interval. Missing coverage refuses attribution. If any target change is detected, retain the attempt and behavioral observations but mark attribution invalid. Prefer immutable preview deployments over busy shared staging. The target URL must be configured by an authorized operator and validated against adapter policy, not taken unchecked from arbitrary PR output.

Report execution and attribution independently:

| Dimension | Example states |
| --- | --- |
| Execution | Not started, running, completed, cancelled, timed out |
| Behavior | Passed, failed, blocked, unmeasured |
| Attribution | Matched, mismatched, changed during execution, unknown |
| Inventory | Complete, skipped required checks, missing tests, inconsistent report |
| Artifacts | Available and verified, missing, upload failed, expired |

A gate may pass only when every required dimension is acceptable under the pinned policy. Passing after a retry retains earlier failures and exposes flakiness. An infrastructure block must not be mislabeled as a product failure or a pass.

Acceptance checks:

- A user connects an existing supported Playwright suite without writing a custom dispatcher or evidence publisher.
- A deliberately broken product assertion produces failed acceptance with a useful trace.
- Missing, skipped, empty and inconsistent reports never produce success.
- Changed target identity during execution, including A → B → A between boundary checks, yields an attribution refusal; unknown interval coverage cannot pass.
- A test attempting to submit its own trusted evidence is refused.
- Timeout/revocation while a runner still mutates a test account cannot release it to a retry. Partition/restart tests prove no overlapping authority or effects; unsupported fencing and unknown settlement visibly block dispatch.
- A candidate that weakens an assertion, substitutes a helper/configuration or changes a pinned test bundle cannot produce accepted evidence without an independently authorized bundle and requirement revision. Attempts to mutate the approved bundle or redirect imports after preflight verification fail at the execution boundary.
- Missing required screenshots/traces/reports prevents acceptance even if the runner exits zero.
- Unauthorized and cross-repository artifact reads fail; public PRs expose no private evidence. Seeded sensitive data is redacted/excluded under the configured capture policy, retention deletion is verified, and storage failure cannot silently publish unsafe or incomplete evidence.
- Setup without executable tests says what is missing and does not invent coverage.

## D3 — Releases and observed production delivery

*Shipped as the release model, observation protocol and bounded reconciliation. See [releases and observed production delivery](delivery.md) for the records, the observer and promoter identities, and the derived verification statuses. No provider adapter ships with it: an observer is an operator-run process with its own credential, and Railway's API does not expose measured runtime artifact identity, so a Railway observer would report `unknown` — which the protocol refuses to verify, by design. Behavioral checks bound to a release rather than a work item's candidate are not part of this increment. The requirements below remain the standard this path is held to; the acceptance checks at the end of this section are the ones `tests/delivery.test.ts` runs, one named test per check.*

Add `Release`, explicit release membership, expected service manifests and append-only deployment observations. Keep desired state separate from provider-reported deployment success and independently observed runtime state. Record deployment time, observation time and receipt time separately.

Release creation, immutable membership/manifest revisions and selection of the expected release require an authenticated promotion principal explicitly authorized for the repository, environment and services. Implementation workers and observation-only adapters cannot change desired state. Each selection transaction compares the expected current generation and, for delegated jobs, the current principal-bound lease epoch, checks the configured promotion/approval policy, then appends history and advances the generation atomically. Approval binds the exact manifest, source/artifact provenance and policy revision; changing any of them requires fresh authorization. A deployment notification cannot choose its own expected release.

Deployment observers use individually authenticated, environment/service-scoped identities. The ingestion transaction derives the actor and scope from credentials, verifies the current adapter/job lease epoch and selected release generation, and enforces idempotency before changing authoritative environment state. External reads happen outside that transaction and must be fenced again when applying their results. Raw webhook payloads are notifications to refetch through a trusted adapter, not production proof. Superseded-lease, unauthorized and out-of-generation observations cannot authorize gates; retain safe rejection metadata as explicitly non-authoritative history. Duplicate receipts cannot refresh the original observation time or advance work twice.

Use provider-specific adapters for deployment identity and health; do not put Railway-specific assumptions in the core gate engine. In the first supported Railway path, verify which available provider/runtime facts establish artifact identity before promising that every process runs the expected code. Runtime artifact identity must come from trusted provider/host measurement or equivalent attestation of the actual running bytes, bound to the concrete instance and observation interval. An application-controlled version endpoint, header or claimed build ID remains a non-authoritative diagnostic even when fetched by an authenticated observer. The same independent measurement rule applies to D2 target attribution; source/build provenance alone does not prove which bytes served the test traffic. Where independent runtime identity cannot be established, show unknown and refuse identity-dependent gates rather than falling back to an application self-report.

Production authorization requires a coherent observation window across every required service, including every required instance during rolling deployments. Use an atomic provider snapshot or overlapping, gap-free identity/health validity histories establishing a common interval for the entire expected manifest and any required behavioral checks. Independently sampled latest observations, even recent sequential probes, cannot prove simultaneity. Pin the selected release generation and policy, apply configured freshness bounds using trusted observation times, and refuse when coverage, membership, freshness or common-interval attribution is unknown. A later change invalidates current health without rewriting the historical authorization.

Reconcile the range between successful release anchors and what is actually observed running. Deployments can include several PRs, skip intermediate builds or supersede an earlier rollout. Release membership must account for reverts and explicit artifact contents; ancestry alone does not prove that an intended behavior survived.

Bounded sweeps require continuation cursors. Missing webhooks, coalesced workflow runs and late observations must converge through periodic reconciliation. A newer release superseding an old one is different from the old release being unhealthy. Do not mark work complete twice when it belongs to multiple observed releases.

Acceptance checks:

- A mixed-version deployment does not pass expected-service verification.
- Staggered observations where A matches only before B matches cannot pass production. Missing instances, coverage gaps and stale snapshots also refuse; a common verified interval must cover the complete required manifest and checks.
- Wrong-scope observers, superseded lease epochs, stale release generations and raw webhook assertions cannot change authoritative runtime state or authorize production; duplicate observations are idempotent.
- Workers and observation adapters cannot create or select desired releases; concurrent promotion selections use generation fencing, stale delegates fail, and approvals cannot authorize a changed manifest.
- A green deployment job with unknown runtime identity remains unverified.
- A wrong artifact that self-reports the expected digest/build ID cannot pass target or production attribution; only independently measured instance identity can authorize it.
- A dropped webhook is recovered by polling/sweep without manual lifecycle changes.
- A release containing multiple PRs attributes all applicable work, with visible membership.
- A sweep interrupted at its bound resumes without silently omitting history.
- Later failures create a visible incident/follow-up without erasing prior evidence or rewriting historical authorization.

## D4 — Operate runners and recover delivery failures

*Shipped as capacity reporting, request diagnostics and backpressure on the runner path, an artifact backend interface with an S3-compatible option, capacity bound, verified retention and digest-checked migration, and the authorized, fenced, observed rollback workflow. See [runner capacity, artifact operations and delivery recovery](recovery.md). The requirements below remain the standard this path is held to; the acceptance checks at the end of this section are the ones `tests/recovery.test.ts` runs, one named test per check.*

Extend the execution-resource safety shipped in D2 with capacity reporting, backpressure, queue dwell and richer dispatch/heartbeat diagnostics. Execution-scoped leases, external fencing and verified settlement before reassignment are D2 prerequisites; D4 adds operational scale without relaxing those guarantees.

Extend D2's already-shipped private artifact storage, access controls, hashes, retention and redaction with a documented backend interface, capacity management, S3-compatible options and operational recovery. Backend migrations must preserve authorization and retention policies, and verify artifact integrity. Baseline security and durable storage are prerequisites from D2, not deferred to this increment.

Rollback is a supported integration workflow, not an arbitrary shell command. Record the failed candidate, approved rollback target, provider operation, resulting observations and linked repair work. Authenticate rollback executors with environment/service-scoped authority. Authorize each operation transactionally against the selected rollback target, current release generation and executor lease epoch, retaining its operation identity across retries. The external mutation itself must enforce a provider-side generation/precondition or equivalent fencing. A local check before and after an API call does not close the race with a superseding decision. Where a provider cannot fence writes, require a serialized in-flight operation barrier: lease expiry alone cannot release it, authorize a successor mutation or supersede its target until the previous operation is proven settled or cancelled. Unknown outcomes block further mutations pending reconciliation. Adapters that cannot establish either guarantee must not offer automatic rollback. Automatic rollback should be opt-in and constrained to tested reversible actions. Database migrations and external side effects require an explicit recovery plan; the system must not claim they are undone because an application image changed.

Acceptance checks:

- Queue starvation, unacknowledged dispatch and missing runner heartbeat have distinct next steps.
- Network partition recovery cannot grant two authoritative attempts the same protected execution resource.
- Artifact upload failure and expired artifact retention are visible proof states.
- A requested rollback is not complete until the target deployment is observed and required checks pass.
- Recovery after server restart preserves the external operation identity and avoids duplicate side effects.
- A partitioned rollback executor cannot apply an obsolete target after authority changes; tests cover delayed provider calls, lease expiry, target supersession and ambiguous outcomes. An unfenced adapter refuses automatic rollback, and an unresolved serialized operation blocks successors.

## D5 — Generalized reports, runners and installation

*Shipped for the parts below; the remaining limits are stated. See [report adapters](report-adapters.md) for the adapter contracts, [deployment](deployment.md) for versioned images, the Helm chart, upgrades, backups and restores, and [operations](operations.md#readiness-checklist-per-completion-profile) for the readiness checklist. Deployment-provider adapters follow D3's release observations and are not part of this increment; production verification therefore remains a manual proof, and the checklist says so.*

After D2 works, add adapters based on actual user demand: supported unit/integration report formats, additional E2E frameworks and deployment providers. Each adapter must declare what it can prove, what is independently observed, supported versions and failure semantics. Contract fixtures cover real payloads and unknown formats fail visibly; avoid another brittle prose approval dependency.

Provide versioned Docker images and documented upgrade, backup and restore procedures. Add a Helm chart when the actual deployment topology and Kubernetes operating requirements are established; a chart should ship with tested persistence, secrets, migrations and upgrade behavior rather than merely wrap the container.

Installation itself has shipped: `graphyard install` provisions Postgres and the
application on Railway, Hetzner, a Docker host, or local Compose, generates one credential
per role, completes the GitHub App, webhook, branch protection and CI identity discovery,
registers agent profiles, and verifies the result. See [install](install.md). Detection still
does not silently authorize a privileged integration: a proof producer is created only from
an explicit `--producer-proof` grant, and the App-bound merge check is required only once
Graphyard has published it.

What remains here is breadth rather than the first path: more deployment providers behind the
same adapter interface, and a readiness checklist for each selected completion profile.

Acceptance checks, with where each is exercised:

- A clean machine can deploy and connect a supported repository using the documented path. — `scripts/verify-image-release.mjs` starts the versioned image against an empty database on every CI run and release; `deploy/helm/exercise.sh` installs the chart on a fresh kind cluster; `tests/init-scan.test.ts` connects a scanned repository through `init --scan --apply` and `doctor`. The Railway and Compose walkthroughs on a machine nobody has prepared remain an operator-witnessed manual proof.
- The first real PR visibly progresses through the configured proof and delivery stages. — `graphyard doctor --profile` reports what is configured, and `tests/system.test.ts` drives a PR through every gate; the real PR on a fresh installation is the manual proof, as the checklist itself states.
- Missing credentials, permissions or unsupported test formats have direct recovery instructions. — `tests/readiness.test.ts` and the `doctor` CLI test: every `missing` and `unknown` item carries the command or setting that resolves it; frameworks without a report adapter are named as unsupported with the recovery.
- Upgrade and restore exercises preserve assignments, event history, scenario revisions and pending requests. — `tests/backup-restore.test.ts` (an assignment under lease with its workspace, append-only history, two scenario revisions, a validation request mid-collection with a private artifact, and the proof-grant ledger after a grant made only in Graphyard and a revoked environment seed, restored into a fresh database, migrated again, and continued under the same epoch with the bootstrap seed re-materializing nothing), the same round trip through the shipped image in `scripts/verify-image-release.mjs`, and the chart's upgrade-then-restore drill in `deploy/helm/exercise.sh`.
- Self-hosted Graphyard remains fully useful without a cloud subscription. — versioned images, Compose, the Helm chart, `db backup`/`db restore` and the readiness checklist need no hosted account; `tests/deployment-packaging.test.ts` holds the packaging to one version everywhere it is stamped. Railway stays a supported guided deployment, not a requirement.

## D6 — Evidence replay, compatible reuse and analytics

These optimizations follow a correct pinned-candidate path. They are not prerequisites for initial turnkey E2E execution.

Replay deterministic verifiers over sanitized retained artifacts with explicit coverage. A clean replay without required instrumentation is unmeasured; replay does not establish current deployment health.

Consider evidence reuse only with a defensible applicability definition covering dependencies, lockfiles, build inputs, configuration, migrations and relevant services. Reuse also requires exact requirement revision, scenario revision/hash, proof policy revision and approved executable oracle bundle identity/digest, together with target/environment scope and required evidence freshness. A change to any of those forbids reuse even if the product code is unchanged. No cross-revision compatibility mapping is included in D6; any future relaxation needs its own separately reviewed non-weakening policy. Missing scope falls back to exact binding. Only the newest compatible attempt may authorize reuse, and it must satisfy every required execution, behavior, attribution, inventory and artifact condition. A newer queued, running, blocked, timed-out, unmeasured or incomplete attempt prevents fallback to an older pass. Order attempts by a durable sequence, not result arrival time; delayed older results cannot regain authority. Measure avoided work and false reuse before enabling broad reuse policies.

Add cost and duration analytics from optional runner-supplied measurements. Distinguish observed cost, estimated cost and unavailable cost; do not rank agents as if workloads were comparable without context.

*Shipped ahead of reuse: [candidate-to-deployment attribution](attribution.md) binds every validation request to its exact manifest, compatibility signature and independently observed target, re-anchors safely when the target moves, and measures avoided runs, wasted runs and unsupported claims — the accounting any later reuse policy must be judged against. No reuse is enabled by it.*

Acceptance checks:

- Relevant dependency/configuration changes invalidate reuse.
- Requirement, scenario, proof policy or approved oracle-bundle changes invalidate reuse even when source/build dependencies are unchanged; target scope and freshness must still match.
- Newer blocked, timed-out, unmeasured or artifact-incomplete attempts prevent fallback to older passes; delayed older results cannot override the newest attempt.
- Unknown scope never widens evidence applicability.
- Replay reports coverage and cannot authorize current live behavior by itself.
- Redaction and retention rules apply to replay inputs and exports.

## Definition of the eventual off-the-shelf experience

For a supported stack, a user installs Graphyard, connects a repository and environments, reviews proposed requirements, and runs agents through their preferred runtime. Graphyard handles assignment, isolation registration, conflict visibility, review, runner dispatch, evidence, deployment attribution, recovery and progression. The UI explains what is waiting and what action resolves it.

Application-specific test code, credentials, production risk decisions and unsupported provider capabilities remain explicit inputs. “Turn it on and cover the lifecycle” must mean useful integrations and honest verification, not automatic claims that an arbitrary application is correct.
