<!-- page: Understand or contribute | 3 | profiles, increments. -->
# Turnkey E2E execution and verified delivery

For a reader asking what comes next: which completion profile a delivery may claim.

## Product promise and boundary

Graphyard discovers supported infrastructure, proposes a delivery profile, configures adapters, dispatches validation, collects results and explains every refusal. A repository without tests needs scenarios and executable assertions first: a planning agent may propose them, but Graphyard never manufactures passing evidence or presents inferred criteria as verified requirements. A labelled profile keeps a green merge from standing in for verified production behaviour.

- **Through merge:** A verified, authorized merge completes the configured workflow
- **Preview validation:** A pinned preview artifact plus required behavioural proof
- **Production verification:** Expected artifacts independently observed across required production services, with required checks passing

## Increments

Each is shipped once the invariants its page states hold:

- **D1** immutable candidates, environments and the runner protocol: [validation](validation.md)
- **D2** one supported runner from guided setup to trusted results: [runner setup](runner-setup.md)
- **D3** deployment observations, release membership and production verification: the model and protocol only, [delivery](delivery.md); no provider adapter
- **D4** capacity, recovery, artifact operations and safe rollback: [recovery](recovery.md)
- **D5** additional runner and report adapters, and off-the-shelf packaging: in part, [report adapters](report-adapters.md), [deployment](deployment.md); deployment-provider adapters are excluded, so production verification stays a manual proof
- **D6** evidence replay, safe reuse and cost analytics: [evidence reuse](evidence-reuse.md)
