# Graphyard documentation

Choose one path. The reference guides are there when a gate or integration needs deeper investigation.

The sections below are generated from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`; add the line to a new page and regenerate.

<!-- index: docs, docs/history | Start here; Operate Graphyard; Build integrations; Understand or contribute; Maintainer and historical records -->

## Start here

1. [Install Graphyard](install.md) — the one command, the agent-executable runbook behind it, and the App-permission migration an upgrade can require.
2. [How Graphyard works](how-graphyard-works.md) — the lifecycle and authority model in five minutes, with diagrams.
3. [Glossary](glossary.md) — human operator, agent session, principal, lease, reviewer, proof producer, control plane, runtime: one definition each, plus the diagram legend.
4. [Onboard a repository](onboarding.md) — the human prompts, more machines, the master, and the first PR.
5. [Local quickstart](quickstart.md) — install locally with `--provider compose` for evaluation.

## Operate Graphyard

- [Deployment](deployment.md) — provider reference behind the installer: versioned images, the variables table, a manual fallback for Railway, Docker Compose and the Helm chart, backups, upgrades, and restores.
- [GitHub enforcement](github.md) — App permissions, branch protection, CI producers, and Codex review.
- [Herdr integration](herdr.md) — worker installation and multi-machine use.
- [Master-agent operating mode](master-agent.md) — routing, recovery, and guarded merges.
- [Slice-lead delegation](delegation.md) — bounded product, infrastructure, and docs/experience coordination.
- [Operations and recovery](operations.md) — daily checklist, incident decision tree, and recovery recipes in three minutes.
- [Operations reference](operations-reference.md) — every procedure in full, credentials, proof authority, drift, and scale limits.
- [Coordinating independent agents](coordination.md) — dependencies, requirement revisions, overlap, and shared resources.
- [Scoped operator-agent automation](operator-automation.md) — least-privilege operator agents with server-enforced scope.
- [Shipping pulse](shipping-pulse.md) — repository delivery flow: throughput, intent-to-merge, and deployment lag without rankings.
- [Flow analytics](flow-analytics.md) — delivery bottlenecks, phase durations, and their data lineage.

## Build integrations

- [Agent protocol and HTTP API](protocol.md) — roles, requests, work commands, leases, workspaces, evidence, and the webhook, one topic per page.
- [E2E test-case registry](test-cases.md) — versioned E2E scenarios pinned to environments.
- [Validation candidates and runner protocol](validation.md) — candidates, dispatch, attempts, and trusted result collection.
- [The packaged Playwright runner and collector](runner-setup.md) — the packaged Playwright runner, host attestor, and collector.
- [Report adapters](report-adapters.md) — what each supported report format proves, observes and refuses.
- [Releases and observed production delivery](delivery.md) — release builds, approvals, and observed production delivery.
- [Candidate-to-deployment attribution](attribution.md) — release manifests, exact-target validation, safe re-anchoring, and attribution analytics.
- [Runner capacity, artifact operations and delivery recovery](recovery.md) — runner capacity, artifact retention and migration, and fenced rollback as an observed workflow.
- [Evidence replay, scoped reuse and execution analytics](evidence-reuse.md) — replay of retained artifacts with explicit coverage, scoped reuse of the newest compatible attempt, and execution cost analytics.

## Understand or contribute

- [Architecture and correctness model](architecture.md) — the correctness model behind ownership, evidence, and gates.
- [Development and dogfooding](development.md) — repository layout, where new features go, and dogfooding.
- [Turnkey E2E execution and verified delivery](turnkey-delivery-roadmap.md) — planned work, clearly separated from shipped behavior.
- [Graphyard visual identity](visual-identity.md) — the marks, palette, and voice the dashboard and docs share.

## Maintainer and historical records

- [Graphyard repository bootstrap](first-pr.md) — repository-specific bootstrap procedure for Graphyard maintainers.
- [Implementation audit — September 13, 2026](history/implementation-audit-2026-09-13.md) — what the September 2026 audit found and what it changed.
- [Huck Engineer investigation: lessons for Graphyard](history/huck-engineer-comparison.md) — what Huck Engineer taught Graphyard about worker pipelines.
- [Role-glossary audit — September 18, 2026](history/role-glossary-audit-2026-09-18.md) — the ambiguity audit, concision samples, and safety-parity check behind the glossary.
<!-- /index -->

Historical records explain past decisions. They are not current setup instructions.
