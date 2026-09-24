<!-- page: Maintainer and historical records | 1 | repository-specific bootstrap procedure for Graphyard maintainers. -->
# Graphyard repository bootstrap

> **Maintainer guide** for `cryptob1/graphyard`. New users follow [repository onboarding](onboarding.md).

## Bootstrap sequence

1. `node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --token-stdin` (paste the worker token, Enter, Ctrl-D).
2. `node "$GRAPHYARD_CLI" github-setup https://YOUR-GRAPHYARD-HOST`, then copy the App's private values into the deployment and redeploy.
3. `node scripts/configure-integrations.mjs --plan`, then `--apply`.
4. `node scripts/protect-github.mjs --plan`, review, apply.
5. Open a linked PR and capture the refusal with `node scripts/verify-enforcement.mjs GY-N PR_NUMBER`.
6. Dispatch the protected workflow for the required proof:

   ```sh
   gh workflow run acceptance.yml --ref main \
     -f pr=PR_NUMBER -f work_id=WORK_UUID -f policy_revision=1 \
     -f proof=integration:claim-safety
   ```

7. Confirm review, CI, evidence, protection and guarded merge pass; re-run `verify-enforcement` for a `permitted` report. The refused and permitted reports support the `manual:github-enforcement` attestation; they are not evidence.

## Trust boundary

The exercise job runs candidate code with disposable principals. A separate `graphyard-reporting` environment holds the producer credential and publishes only the fixed inventory `scripts/contracts.mjs` registers for the dispatched proof. PR code never receives the production token.

## Adding a trusted contract

A trusted run executes only protected source, and preparation refuses a candidate whose base lacks the contract's source file. So land the harness, its registry entry and its unprivileged CI job first; require the proof only of later work. A contract exports `requiredCases`, `createInventory` (via `scripts/case-inventory.mjs`), `exercise`, and optionally `candidate` for a protected launcher.

Registered contracts: `integration:claim-safety` (authorization, competing claims, stale epochs, evidence trust), `integration:herdr-recovery` ([cross-machine recovery](herdr.md#automated-recovery-contract)), `integration:merge-authorization` (the [merge broker](github.md#enforcement-boundary) and revocation). None replaces the [two-machine drill](coordination.md#two-machine-operational-drill).
