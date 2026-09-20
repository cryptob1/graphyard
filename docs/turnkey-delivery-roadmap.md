<!-- page: Understand or contribute | 3 | profiles, increments, what shipped. -->
# Turnkey E2E execution and verified delivery

For a reader asking what comes next.

## Product promise and boundary

Graphyard discovers supported repository and deployment infrastructure, proposes an explicit delivery profile, configures supported adapters, dispatches required validation, collects results and explains every refusal. A repository without tests needs scenarios and executable assertions created first: a planning agent may propose them, but the product must never manufacture passing evidence or present inferred criteria as verified requirements. Profiles are labelled precisely — a green merge never silently stands in for verified production behaviour, and completed work keeps its recorded completion meaning.

- **Through merge:** A verified, authorized merge completes the configured workflow
- **Preview validation:** A pinned preview artifact plus required behavioural proof
- **Production verification:** Expected artifacts independently observed across required production services, with required checks passing

## Increments

| Increment | Outcome | Status |
| --- | --- | --- |
| D1 | Immutable candidates, environments and the runner protocol | Shipped — [validation](validation.md) |
| D2 | One supported runner from guided setup to trusted results | Shipped — [runner setup](runner-setup.md) |
| D3 | Deployment observations, release membership and production verification | Shipped as the model and protocol — [delivery](delivery.md); no provider adapter |
| D4 | Capacity, recovery, artifact operations and safe rollback | Shipped — [recovery](recovery.md) |
| D5 | Additional runner and report adapters, and off-the-shelf packaging | Shipped in part — [report adapters](report-adapters.md), [deployment](deployment.md); deployment-provider adapters are excluded, so production verification stays a manual proof |
| D6 | Evidence replay, safe reuse and cost analytics | Shipped — [evidence reuse](evidence-reuse.md) |

## The standards each increment is held to

Every increment keeps the invariants its own page states: authority derived from authentication and checked in one transaction ([roles](protocol/roles.md)), exact pinning of work revision, scenario, bundle digest, source and target ([validation](validation.md)), execution separated from the trusted collector ([runner setup](runner-setup.md)), release membership that accounts for reverts and rollback only where a provider write can be fenced ([delivery](delivery.md), [recovery](recovery.md)), adapters that declare what they prove and refuse ([report adapters](report-adapters.md)), and reuse ordered by durable sequence with observed, estimated and unavailable cost kept apart ([evidence reuse](evidence-reuse.md)).
