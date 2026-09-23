<!-- page: Maintainer and historical records | 2 | audits, lessons. -->
# Audits and adopted lessons

For a maintainer asking why a correctness rule exists: what each review changed.

## Implementation audit — September 13, 2026

Measured against its specification, the bootstrap implementation was a useful control plane, not an enforced delivery system. Eleven defects were fixed, each now a shipped rule with regression coverage: observations applied after a job lease expired, an obsolete passing revision published on provider delay, evidence collected across candidates, a retry key replaying an old heartbeat, `watch` launching implementation code with an operator token, a worker outliving supervision, path aliases bypassing reservation checks, the installed CLI resolving its runtime from the caller's directory, submitted rework disappearing from `next`, an in-flight acknowledgment overwriting a newer wakeup, and a merge discovered after an outage losing its authorization.

## Role-glossary audit — September 18, 2026

Seven recurring substitutions across the guides each resolved into one canonical term: the **Canonical usage** and **Never** entries of [the glossary](../glossary.md#the-eight-distinctions), which `tests/docs-glossary.test.ts` keeps from drifting.

## Huck Engineer investigation

Where each adopted lesson lives:

- Derive requirement satisfaction from evidence, not a status field: [architecture](../architecture.md)
- Reconcile release ranges, not only triggering commits: [delivery](../delivery.md)
