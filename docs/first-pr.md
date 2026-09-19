# Graphyard repository bootstrap

> **Maintainer guide.** This procedure is specific to `cryptob1/graphyard`. New users should follow [repository onboarding](onboarding.md).

Graphyard's own repository uses a protected acceptance workflow to prove its HTTP coordination contracts without exposing production credentials to pull-request code.

## Bootstrap sequence

1. Run repository discovery and install the Herdr worker connection:

   ```sh
   export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
   node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --token-stdin
   ```

   Paste the worker token, press Enter, then press Ctrl-D to send EOF.

2. Run `node "$GRAPHYARD_CLI" github-setup https://YOUR-GRAPHYARD-HOST`, register the personal-account GitHub App, copy its private values into Railway, and redeploy.
3. Preview and apply this repository's integration configuration:

   ```sh
   node scripts/configure-integrations.mjs --plan
   node scripts/configure-integrations.mjs --apply
   npx @railway/cli config plan
   npx @railway/cli config apply
   npx @railway/cli up --service graphyard --detach
   ```

4. Protect `main` with `node scripts/protect-github.mjs --plan`, review the output, then apply it.
5. Open a Graphyard-linked PR. Confirm `Graphyard / merge` refuses before acceptance evidence exists. Capture the refusal with `node scripts/verify-enforcement.mjs GY-N PR_NUMBER`; its report names the publishing App, the observed protection, and every refusing gate.
6. Dispatch the protected workflow from `main`:

   ```sh
   gh workflow run acceptance.yml --ref main \
     -f pr=PR_NUMBER -f work_id=WORK_UUID -f policy_revision=1 -f proof=integration:claim-safety
   ```

   Each dispatch produces exactly one proof. Pass `-f proof=integration:merge-authorization` to run the merge-broker contract instead; the workflow refuses a proof this harness cannot produce, and the reporter refuses a report whose case inventory does not match the proof it claims.

7. Confirm current-head review, CI, trusted acceptance evidence, branch protection, and guarded merge all pass. Rerun the inspection; the same command should now report `permitted` with no refusals. Push a new commit once to verify old proof becomes stale.

## Trust boundary

The exercise job runs candidate code with disposable principals. A separate `graphyard-reporting` environment holds the producer credential and publishes only a fixed case inventory, per proof. PR code never receives the production Graphyard token.

`integration:claim-safety` covers API authorization, competing claims, stale epochs, worker evidence trust, and unfinished dependencies. `integration:merge-authorization` covers the restricted [merge broker](github.md#enforcement-boundary): who may reach it, who may revoke accepted evidence, and that a revoked candidate is refused by acquisition, replay, verification, concurrent attempts, and post-merge attribution. That scenario needs an observed GitHub candidate, which no client-controlled route can invent. A protected launcher supplies those observations inside the isolated candidate container, while the protected controller drives the candidate only over HTTP and judges the observed responses in a separate process using `scripts/acceptance-contract.mjs`. Candidate output is never accepted as the proof transcript.

Neither proof establishes arbitrary product behavior, cross-machine recovery, or production delivery.

The refused and permitted reports are the operator's inspection record for the `manual:github-enforcement` criterion. They are not evidence: an operator inspects them and attests the proof from a separate admin session, and Graphyard re-verifies the exact candidate before merging.

After this loop succeeds, route further Graphyard work through Graphyard-assigned worktrees. See [development](development.md) for repository rules and [GitHub enforcement](github.md#inspect-enforcement) for the general integration model.
