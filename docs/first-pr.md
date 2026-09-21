<!-- page: Maintainer and historical records | 1 | this repository’s bootstrap. -->
# Graphyard repository bootstrap

For a maintainer of `cryptob1/graphyard`: how it proves its own contracts.

## Bootstrap sequence

1. `node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --token-stdin` installs the Herdr worker connection.
2. `node "$GRAPHYARD_CLI" github-setup https://YOUR-GRAPHYARD-HOST` registers the personal-account App; copy its private values into the deployment and redeploy.
3. Preview and apply the integration configuration: `node scripts/configure-integrations.mjs --plan`, then `--apply`, then the provider's plan, apply and deploy.
4. Protect `main` with `node scripts/protect-github.mjs --plan`, review, then apply.
5. Open a Graphyard-linked pull request and confirm `Graphyard / merge` refuses before acceptance evidence exists, capturing the refusal with the inspection below.
6. Dispatch the protected workflow from `main`, naming the contract the item requires: `gh workflow run acceptance.yml --ref main -f pr=PR_NUMBER -f work_id=WORK_UUID -f policy_revision=1 -f proof=integration:claim-safety`.
   - The proof resolves against `scripts/contracts.mjs` in that protected checkout; a checkout not registering it refuses the dispatch before any candidate code is fetched
   - Each dispatch produces exactly one proof; the reporter refuses a report whose case inventory does not match the proof it claims
7. Confirm current-head review, CI, trusted acceptance evidence, protection and the guarded merge all pass, rerun the inspection for `permitted`, then push one commit to verify old proof becomes stale.

## Adding a trusted contract

A trusted run executes only protected source, so a contract must reach protected `main` before any work item may require its proof: land the harness, its registry entry and its unprivileged CI job as their own change, gated by the existing review, CI and proofs, then require the new proof of later work.

## Inspect enforcement

`node scripts/verify-enforcement.mjs GY-N [PR_NUMBER]` joins live GitHub and Graphyard observations for one submitted item into a read-only report.

- **Reports:** which App published `Graphyard / merge` on the exact head, protection settings the merge verifier requires, every gate with its refusal reasons, GitHub's mergeability
- **Requires:** a completed successful run from its bound App for every protected required context, not only `Graphyard / merge`
- **Refuses:** mismatched candidate, stale observation or blocking merge state
- **Re-reads immediately before reporting:** item, pull request, check runs, protection and server time, refusing if any merge-controlling state changed during collection
- **Verdict:** `refused` while anything would block the merge, `permitted` only when everything allows it
- **Notes:** what it does not read, including repository rulesets and a check inherited from another pull request on the same commit

