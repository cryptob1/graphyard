# Graphyard documentation

Choose one path. The reference guides are there when a gate or integration needs deeper investigation.

The sections below are generated from each page's `<!-- page: Section | order | summary -->` line by `npm run docs:check -- --write`; add the line to a new page and regenerate.

<!-- index: docs, docs/history | Start here; Operate Graphyard; Build integrations; Understand or contribute; Maintainer and historical records -->

## Start here

1. [How Graphyard works](how-graphyard-works.md) — the lifecycle and authority model in five minutes, with diagrams.
2. [Glossary](glossary.md) — human operator, agent session, principal, lease, reviewer, proof producer, control plane, runtime: one definition each, plus the diagram legend.
3. [Onboard a repository](onboarding.md) — Railway, GitHub, Herdr, master, workers, and the first PR.
4. [Local quickstart](quickstart.md) — run Graphyard locally for evaluation.

## Operate Graphyard

- [Deployment](deployment.md) — Railway, Docker Compose, backups, and upgrades.
- [Install and upgrade](install.md) — the shortest install path and the App-permission migration an upgrade can require.
- [GitHub enforcement](github.md) — App permissions, branch protection, CI producers, and Codex review.
- [Herdr integration](herdr.md) — worker installation and multi-machine use.
- [Master-agent operating mode](master-agent.md) — routing, recovery, and guarded merges.
- [Slice-lead delegation](delegation.md) — bounded product, infrastructure, and docs/experience coordination.
- [Operations and recovery](operations.md) — daily checklist, incident decision tree, and recovery recipes in three minutes.
- [Operations reference](operations-reference.md) — every procedure in full, credentials, proof authority, drift, and scale limits.
- [Coordinating independent agents](coordination.md) — dependencies, requirement revisions, overlap, and shared resources.
- [Scoped operator-agent automation](operator-automation.md) — least-privilege operator agents with server-enforced scope.
- [Shipping pulse](shipping-pulse.md) — repository delivery flow: throughput, intent-to-merge, and deployment lag without rankings.

## Build integrations

- [Agent protocol and HTTP API](protocol.md) — roles, requests, work commands, leases, workspaces, evidence, and the webhook, one topic per page.
- [E2E test-case registry](test-cases.md) — versioned E2E scenarios pinned to environments.
- [Validation candidates and runner protocol](validation.md) — candidates, dispatch, attempts, and trusted result collection.
- [The packaged Playwright runner and collector](runner-setup.md) — the packaged Playwright runner, host attestor, and collector.
- [Releases and observed production delivery](delivery.md) — release builds, approvals, and observed production delivery.
- [Runner capacity, artifact operations and delivery recovery](recovery.md) — runner capacity, artifact retention and migration, and fenced rollback as an observed workflow.

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
