<!-- page: Agent protocol | 1 | bearer authentication and what each credential role may do. -->
# Roles and credentials

All control-plane endpoints except `/healthz` require `Authorization: Bearer TOKEN`. Use HTTPS for remote machines. API credentials are not Git credentials.

Terms follow the [glossary](../glossary.md). On the protocol pages *operator* means the human operator acting with the `admin` credential (the server's refusal text says `Operator permission required`); *operator agent* means the scoped `operator-agent` role.

| Role | Permissions |
| --- | --- |
| `admin` | Create/release work, revise requirements, rework, participate as a worker, attest manual proofs, grant proof authority; with `sessionKind: "human"`, resolve escalations and record human-only intake |
| `coordinator` | Read work and integration state for master-agent routing; acquire, verify, or cancel only the engine's bounded merge execution authority; settle a containment quarantine whose supervisor it has verified dead on the registered host; record the deployment observation on delivered work |
| `operator-agent` | Only explicitly configured intent/policy capabilities (`intent:create`, `intent:ready`, `intent:unblock`, `policy:requirements`, `policy:review-provider`, `policy:bootstrap`) within a server-enforced repository/work allowlist; never leases, evidence, identity administration, or merge execution |
| `slice-lead` | Record rulings on work in its own slice and escalate; every lifecycle mutation from this role is refused and recorded, see [slice-lead delegation](../delegation.md) |
| `worker` | Claim work, renew/release own lease, register workspace, report blockers, submit implementation, submit untrusted assertions |
| `producer` | Submit evidence; only proof names authorized by a live Graphyard grant are trusted |
| `reader` | Inspect work, status, events |

Except for operator agents, all roles can read engineering metadata in this single-repository installation and have no per-item read ACL in v0.1. Operator-agent reads are restricted to their server-enforced repository/work scope allowlist. Each concurrent worker session must have its own principal; sharing a token makes sessions indistinguishable.
