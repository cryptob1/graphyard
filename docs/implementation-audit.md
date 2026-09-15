# Implementation audit — September 13, 2026

This review compares the bootstrap implementation with the original Graphyard specification and the subsequent requests for distributed ownership, Herdr integration, Railway deployment, public source, documentation, and E2E case storage. It covers the domain engine, persistence, HTTP boundary, GitHub adapter, CLI, Herdr plugin, UI, deployment files, documentation, tests, and repository history.

The result is a useful bootstrap control plane with several correctness fixes. It is **not yet an enforced end-to-end multi-agent delivery system**. The dedicated GitHub App, trusted test reporter, and real multi-host acceptance exercise remain outstanding. No additional agents were launched during this review.

## Confirmed defects fixed in this audit

| Severity | Failure before the fix | Result and regression coverage |
| --- | --- | --- |
| High | An integration worker could apply observations after its job lease expired. | Observation application checks the current job token and expiry inside the coordination transaction; expired acknowledgment is also refused. Tested against real Postgres. |
| High | Provider delays could publish an obsolete passing work revision. | Publication checks revision, job ownership, and freshness immediately before the write; failure recovery reloads current work. Tested by inserting failed evidence during publication. A cross-system atomicity gap remains below. |
| High | PR changes during multi-request evidence collection could combine facts from different candidates. | The adapter rereads head, base, branch, state, and draft status before accepting the observation; success publication rechecks open/draft/target state. Mock-provider race tests cover these changes. |
| High | A configured command retry key caused automatic heartbeats to replay an old response without extending ownership. | Every automatic heartbeat has a new key. The supervisor has an independent elapsed-time lease deadline and rejects invalid renewal results. CLI and stalled-renewal process tests cover this behavior. |
| High | `watch` could launch implementation code with an operator token or inherited server credentials. | The CLI requires a worker role before launch and strips known server credential variables from the child environment. CLI refusal and subprocess inheritance tests cover this boundary; readable credential files remain the operator's responsibility. |
| High | A worker ignoring SIGTERM or a descendant surviving its leader could continue after supervision ended. | Supervision stops renewals and escalates the process group to SIGKILL after five seconds, even after leader exit. The CLI launcher forwards termination signals. Real subprocess tests verify descendant shutdown. Detached daemons and abrupt supervisor death remain outside containment. |
| Medium | Lexical path aliases and nested workspaces bypassed exact-string reservation checks; malformed branch names were accepted. | Paths are normalized and ancestor/descendant overlaps refused. Git-invalid trailing/repeated branch separators are rejected. Database-backed tests cover aliases and overlaps. |
| Medium | The installed CLI failed when launched from another repository because it resolved its runtime from the caller's directory. | Runtime/module paths resolve relative to the installed launcher. A subprocess test runs from an unrelated directory containing spaces. |
| Medium | Submitted rework disappeared from `next`, and CLI worktree creation selected a new branch that the server refused. | Rework is listed and preserves the existing PR branch in a fresh workspace. Git still refuses unsafe local double checkout. |
| Medium | An in-flight job acknowledgment overwrote a newer wakeup; new evidence did not promptly wake integration; delivered tasks kept polling. | Queue generations preserve wakeups, evidence mutations wake jobs transactionally, and authorized completion removes the job. Database tests cover wakeup preservation and migration reapplication. |
| Medium | A merge discovered after an outage could lose its earlier authorization; later evidence could distort the historical decision. | Merge completion consults immutable snapshots at the reported merge time and records the authorization revision. Tests cover delayed discovery, subsequent failure, and refusal of same-second backfilled authorization. |

The E2E definition form's newline handling was inspected and found correct; it is not a defect or a fix in this review.

## Remaining launch blockers and correctness limits

1. **The deployed service has no dedicated GitHub App configured.** Public-repository protection now requires CI and review, including for administrators, but those checks are not Graphyard's acceptance gate. Install the App, bind `Graphyard / merge` to its identity, and verify a real refused/accepted PR before claiming external enforcement. This is existing dogfooding task GY-1.
2. **GitHub and Postgres cannot provide an atomic cross-system transaction.** A successful check may remain during an outage or after an evidence revocation. The later master-agent work added a bounded, exact-PR/head/base/policy merge execution and final transactional verification; an observed merge without it no longer completes Graphyard work. Repository or organization rules must still restrict alternative merge identities when an out-of-band merge must be prevented rather than detected.
3. **Test inventory is trusted input, not independently extracted by Graphyard.** Named GitHub checks and producer-reported counts are implemented. A separately controlled reporter must inspect actual test reports without exposing its credential to implementation code. Until GY-3 is complete, green CI cannot be described as independent proof that every required scenario ran.
4. **Cross-machine worker recovery is not yet demonstrated.** Tests race 32 claimants through two connection pools on one machine. That proves transactional exclusivity under that test, not network-partition handling or filesystem containment across a fleet. The Herdr plugin is a manual ledger/claim interface, without dispatch ACK or automatic session lifecycle wiring. Exercise GY-2 on two actual hosts before launching a fleet.
5. **Merge attribution is not artifact verification.** The adapter preserves the previously observed base and records the merge SHA. It does not verify the merge/squash/rebase artifact was the artifact tested. Provider/database clock assumptions and whole-second merge timestamps also limit historical ordering; ambiguous same-second authorization is refused conservatively.

Remote host IDs and paths are worker-reported. Lexical overlap checks cannot detect remote symlink aliases, bind mounts, or a worker lying about its machine. A lease cannot revoke Git or filesystem credentials. These are explicit integration boundaries, not guarantees supplied by registration.

## Coverage against the specification

| Specification area | Current implementation | Missing or deferred |
| --- | --- | --- |
| Runtime-independent control plane (§1–5, 25, 29, 34–37) | Separate transactional engine, external CLI/HTTP clients, native Herdr pane | Fully exercised external-runtime lifecycle |
| Engineering graph and gates (§6–7, 21) | Fixed lifecycle; deterministic first-refusal evaluation; durable polling and webhook wakeups | Configurable topology, arbitrary transition policies, deployment branches |
| Evidence and acceptance (§8–10, 19) | Required proof names; exact head/base/policy binding; principal-derived trust; latest failures supersede passing evidence | Layered repository/team policy, automatic infrastructure discovery beyond package scripts, trusted report ingestion, artifact attestations |
| Ledger and Kanban (§11–12) | Create work, dependencies, priority, ownership, snapshots, gate/history display | Import, general edits, cancellation, ordered policy changes, history pagination |
| Delivery graph (§13, 24) | Counts, first refusals, oldest active item, current-age percentiles | Historical dwell/throughput, anomaly thresholds, cost and agent analytics, alerts |
| Worktrees and conflicts (§14–15) | Epoch ownership, host/path and branch reservations, local Git creation, dependency blocking | File-overlap warnings, semantic conflicts, automatic cleanup and reservation repair |
| Agent interface and durability (§16–17) | CLI and HTTP; direct claim acknowledgment; heartbeats; process supervisor | SDK, MCP, durable dispatch/ACK queue, native automatic Herdr lifecycle hooks |
| GitHub and CI (§18, 27–28) | App adapter, PR/review/check observation, App-bound protection verifier, signed webhook | Active App installation here, issue/PR import, trusted test inventory reporter, other providers |
| E2E case storage (additional request) | Immutable versioned definitions, operator edits, requirement-pinned version/hash/environment, evidence linkage | Scheduling/running cases, report ingestion, large artifact storage; executable tests remain in Git |
| Environments, human delivery gates, rollback (§20, 22–23) | Manual acceptance proofs and scenario environment labels | First-class environments/builds/deployments; staging/promotion/production gates; rollback and repair workflows |
| Installation and hosting (§26–28, 32) | Postgres, Dockerfile, Compose, deployed Railway app, hosted docs | npm release/off-the-shelf `npx` install, generic Railway template, Helm chart, SQLite |
| Herdr (additional request) | Plugin manifest and ledger pane; installed locally; protocol guide | Two-host acceptance, dispatch integration, lifecycle signals |
| Documentation (additional request) | Hosted quickstart, architecture, deployment, protocol, GitHub, Herdr, operations, development, and test-case guides | Guides and automation for deferred capabilities as they ship |
| Cloud and scale (§31, 33) | Same core can run self-hosted; database coordination supports replicas | Hosted tenant model, SSO/RBAC administration, enterprise policy, fleet-scale benchmarks |

The five MVP capabilities are present at a bootstrap level. Imports are absent, the delivery topology is fixed, and the live GitHub enforcement loop is not connected. `Done` means a historically authorized observed merge; it does not mean staging acceptance or production delivery.

## Operational debt

- Coordination uses a global advisory lock and reads the work set. Full snapshots and growing evidence arrays are copied into history and receipts, including heartbeats. Storage and latency need measurement before hundreds of workers.
- Work/scenario lists are unpaginated and the event API exposes only the latest 300 events. Durable jobs have fixed retry intervals, with no provider rate-limit budget or circuit breaker.
- Startup DDL is transactional and repeatable, but there is no ordered migration framework yet. Backups and restore drills remain operator responsibilities.
- A submitted task cannot switch PRs. A mistaken association or abandoned reservation has no supported general repair command; design an explicit audited recovery path rather than editing production JSON.
- Static configured principals require redeployment for rotation. No tenant isolation or dynamic token administration is implemented.
- The checked-in Railway configuration describes this deployment and preserves existing values. New installations must adapt identities and supply credentials; the image is built by Railway rather than shipped as a versioned public container release.

## Verification and repository security

The audit adds real Postgres regression tests, mocked GitHub race tests, and real CLI/process tests. Run `npm run build` and `npm test`; these use isolated local data, not production. Provider mocks do not establish real GitHub enforcement, and process tests do not establish cross-machine containment.

Before making `cryptob1/graphyard` public, Gitleaks 8.30.1 scanned every reachable commit and the publication file set without finding a leak. An additional exact-value comparison checked all 73 original Git objects and publication files against the three local live credentials, with no matches. No credential values were printed. Public fixture passwords and replacement examples are not production secrets.

The repository is public, with GitHub secret scanning and push protection enabled. Main requires CI and review, disallows force pushes/deletion, and enforces protection for administrators. This change adds checksum-pinned Gitleaks CI and excludes additional environment/private-key files from Git and Docker context. Secret scanners cannot establish the absence of every possible sensitive string; operational credentials remain in ignored local files and Railway variables.

These audit changes are prepared on `fix/implementation-audit` for review. They are not deployed merely because local validation passed. The original hosted bootstrap remains separate until the reviewed change is merged and deployed.
