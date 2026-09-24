<!-- page: Agent protocol | 1 | bearer authentication and what each credential role may do. -->
# Roles and credentials

Every endpoint except `/healthz` requires `Authorization: Bearer TOKEN`; use HTTPS remotely. *Operator* means the human operator's `admin` credential; *operator agent* the scoped role ([glossary](../glossary.md)).

| Role | Permissions |
| --- | --- |
| `admin` | Create/release work, revise requirements, rework, attest manual proofs, grant proof authority; with `sessionKind: "human"`, resolve escalations and record human-only intake |
| `coordinator` | Read for routing; acquire, verify or cancel the bounded merge execution; settle a verified-dead quarantine; record deployment observations |
| `operator-agent` | Only configured capabilities (`intent:create`, `intent:ready`, `intent:unblock`, `policy:requirements`, `policy:review-provider`, `policy:bootstrap`) within a repository/work allowlist |
| `slice-lead` | Rulings and escalations in its slice ([delegation](../delegation.md)) |
| `worker` | Claim, renew/release its lease, register a workspace, report blockers, submit, submit untrusted assertions |
| `producer` | Submit evidence; trusted only for live granted proofs |
| `reader` | Read work, status, events |

All roles except operator agents read all engineering metadata. Give each concurrent session its own principal.
