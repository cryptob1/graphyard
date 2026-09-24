<!-- page: Understand or contribute | 3 | planned work, clearly separated from shipped behavior. -->
# Turnkey E2E execution and verified delivery

The delivery roadmap (GY-15): from assignment to independently verified delivery. Each increment's acceptance checks are named tests in its test file.

## Product promise and boundary

Graphyard discovers supported infrastructure, proposes an explicit delivery profile, dispatches required validation, collects results and explains every refusal. It never manufactures passing evidence or presents inferred criteria as verified requirements.

A green merge never stands in for verified production behavior:

- **Through merge:** a verified, authorized merge completes the workflow.
- **Preview validation:** a pinned preview artifact plus required behavioral proof is the boundary.
- **Production verification:** expected artifacts are independently observed across required production services and required checks pass.

## Status

| Increment | Outcome | Status |
| --- | --- | --- |
| D1 | Immutable candidates, environments, runner protocol | Shipped — [validation](validation.md) |
| D2 | One Playwright runner from guided setup to trusted results | Shipped — [runner setup](runner-setup.md) |
| D3 | Releases, deployment observations, production verification | Shipped — [delivery](delivery.md) |
| D4 | Runner capacity, artifact operations, fenced rollback | Shipped — [recovery](recovery.md) |
| D5 | Report adapters, packaging, installation | Shipped — [report adapters](report-adapters.md), [deployment](deployment.md), [install](install.md) |
| D6 | Evidence replay, scoped reuse, cost analytics | Shipped — [evidence reuse](evidence-reuse.md), [attribution](attribution.md) |

## D3 — Releases and observed production delivery

Release model, observation protocol and bounded reconciliation. No provider adapter ships: an observer is an operator-run process with its own credential, and runtime identity must be independently measured (a self-report or unknown identity refuses). Checks: `tests/delivery.test.ts`.

## D4 — Operate runners and recover delivery failures

Capacity reporting and backpressure, an S3-compatible artifact backend with verified retention and migration, and a fenced, observed rollback workflow. Checks: `tests/recovery.test.ts`.

## D6 — Evidence replay, compatible reuse and analytics

Replay reports coverage and never authorizes live behavior. Reuse requires exact requirement, scenario, policy and oracle-bundle revisions; only the newest compatible attempt counts. Cost stays observed, estimated or unavailable. Checks: `tests/evidence-reuse.test.ts`.

## Remaining work

- More deployment-provider adapters behind the D3 observation interface; until then production verification is a manual proof.
- Unprepared-machine walkthroughs and the first real PR on a fresh installation remain operator-witnessed manual proofs.
- The real two-host Herdr exercise is GY-2.
