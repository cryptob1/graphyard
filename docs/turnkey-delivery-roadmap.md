<!-- page: Understand or contribute | 3 | profiles and increments. -->
# Turnkey E2E execution and verified delivery

For a reader asking what comes next.

## Product promise and boundary

Graphyard discovers supported repository and deployment infrastructure, proposes an explicit delivery profile, configures supported adapters, dispatches required validation, collects results and explains every refusal. A repository without tests needs scenarios and executable assertions created first: a planning agent may propose them, but the product never manufactures passing evidence or presents inferred criteria as verified requirements. Profiles are labelled precisely, so a green merge never stands in for verified production behaviour.

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

Every increment keeps the invariants its own page states, and none is considered shipped until they hold.
