<!-- page: Maintainer and historical records | 2 | what the 2026 audit changed. -->
# Implementation audit — September 13, 2026

For a maintainer asking why a correctness rule exists: what this audit changed.

> **Historical snapshot.** Use the [documentation index](../README.md) for current setup and operations.

The review compared the bootstrap implementation with the original specification and the later requests for distributed ownership, Herdr integration, Railway deployment, public source, documentation and E2E case storage: a useful bootstrap control plane, not an enforced end-to-end multi-agent delivery system. Eleven defects were fixed, each now a shipped rule with regression coverage — observations applied after a job lease expired, an obsolete passing revision published on provider delay, evidence collected across different candidates, a retry key replaying an old heartbeat, `watch` launching implementation code with an operator token, a worker outliving supervision, path aliases bypassing reservation checks, the installed CLI resolving its runtime from the caller's directory, submitted rework disappearing from `next`, an in-flight acknowledgment overwriting a newer wakeup, and a merge discovered after an outage losing its authorization.
