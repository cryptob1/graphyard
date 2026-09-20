<!-- page: Maintainer and historical records | 1 | this repository's bootstrap procedure. -->
# Graphyard repository bootstrap

For a maintainer of `cryptob1/graphyard`: how it proves its own contracts.

## Bootstrap sequence

1. Install the Herdr worker connection with `node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --token-stdin`.
2. Run `node "$GRAPHYARD_CLI" github-setup https://YOUR-GRAPHYARD-HOST`, register the personal-account App, copy its private values into the deployment and redeploy.
3. Preview and apply the integration configuration: `node scripts/configure-integrations.mjs --plan`, then `--apply`, then the provider's own plan, apply and deploy.
4. Protect `main` with `node scripts/protect-github.mjs --plan`, review the output, then apply it.
5. Open a Graphyard-linked pull request and confirm `Graphyard / merge` refuses before acceptance evidence exists, capturing the refusal with the inspection below.
6. Dispatch the protected workflow from `main`, naming the contract the item requires: `gh workflow run acceptance.yml --ref main -f pr=PR_NUMBER -f work_id=WORK_UUID -f policy_revision=1 -f proof=integration:claim-safety`. The proof resolves against `scripts/contracts.mjs` in the protected checkout that run uses, and a checkout not registering it refuses the dispatch before any candidate code is fetched. Each dispatch produces exactly one proof, and the reporter refuses a report whose case inventory does not match the proof it claims.
7. Confirm current-head review, CI, trusted acceptance evidence, branch protection and the guarded merge all pass; rerun the inspection, which should report `permitted` with no refusals, then push one new commit to verify old proof becomes stale.

## Proofs in CI

The same protected workflow runs on every push to a `graphyard/*` branch with an open pull request into the base branch, through `pull_request_target`, so GitHub takes the workflow file and harness checkout from the default branch while the candidate is only ever fetched into an isolated build context.

## Adding a trusted contract

Because a trusted run executes only protected source, a contract must reach protected `main` before any work item may require its proof. Land the harness, its registry entry and its unprivileged CI job as their own change, gated by review, CI and the proofs that already exist; then require the new proof of later work.

## Inspect enforcement

Configured is not enforced. `node scripts/verify-enforcement.mjs GY-N [PR_NUMBER]` joins live GitHub and Graphyard observations for one submitted item into a read-only report: which App published `Graphyard / merge` on the exact head, the protection settings the merge verifier requires, every gate with its refusal reasons, and GitHub's own mergeability. It paginates check runs, refuses a mismatched candidate, a stale observation or a blocking merge state, and requires every protected required context — not only `Graphyard / merge` — to have a completed successful run from the App it is bound to. Immediately before reporting it re-reads the item, pull request, required check runs and protection, refusing if any merge-controlling state changed during collection (work revision, exact commits, base ref, pull-request state, the run set of a protected context), and reads server time once more so collection time counts against observation freshness as the merge verifier counts it. The verdict is `refused` while anything would block the merge and `permitted` only when everything allows it; notes call out what it does not read, including repository rulesets and a check inherited from another pull request on the same commit.

