<!-- page: Maintainer and historical records | 1 | bootstrap for Graphyard's own repository. -->
# Graphyard repository bootstrap

> For `cryptob1/graphyard` maintainers. Everyone else follows [onboarding](onboarding.md).

## Bootstrap sequence

1. `node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --token-stdin`
2. `node "$GRAPHYARD_CLI" github-setup https://YOUR-GRAPHYARD-HOST`; put the App's private values in the deployment and redeploy.
3. `node scripts/configure-integrations.mjs --plan`, then `--apply`; `node scripts/protect-github.mjs --plan`, then apply.
4. Open a linked PR and record the refusal: `node scripts/verify-enforcement.mjs GY-N PR_NUMBER`.
5. Dispatch the protected proof workflow:

   ```sh
   gh workflow run acceptance.yml --ref main \
     -f pr=PR_NUMBER -f work_id=WORK_UUID -f policy_revision=1 \
     -f proof=integration:claim-safety
   ```

6. After review, CI and evidence pass, re-run `verify-enforcement` for a `permitted` report. The two reports support the `manual:github-enforcement` attestation.

PR code never receives the production token: a separate `graphyard-reporting` environment publishes only the fixed inventory `scripts/contracts.mjs` registers for the dispatched proof.

## Adding a trusted contract

Trusted runs execute only protected source and refuse a candidate whose base lacks the contract. Land the harness, its `scripts/contracts.mjs` entry and its unprivileged CI job first, then require the proof of later work. Registered: `integration:claim-safety`, `integration:herdr-recovery` ([herdr](herdr.md#automated-recovery-contract)), `integration:merge-authorization` ([merge broker](github.md#enforcement-boundary)).
