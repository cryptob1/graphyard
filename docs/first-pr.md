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
5. Open a Graphyard-linked PR. Confirm `Graphyard / merge` refuses before acceptance evidence exists.
6. Dispatch the protected workflow from `main`, naming the contract the work item requires:

   ```sh
   gh workflow run acceptance.yml --ref main \
     -f pr=PR_NUMBER -f work_id=WORK_UUID -f policy_revision=1 \
     -f proof=integration:claim-safety
   ```

   `proof` is resolved against the registry in `scripts/contracts.mjs` in the protected
   checkout this run uses, and the dispatch is refused before any candidate code is fetched
   when that checkout does not register it. Work requiring `integration:herdr-recovery`
   dispatches the same workflow with `-f proof=integration:herdr-recovery`. That contract
   waits out the candidate's real lease and launch fences, so its exercise job runs for
   several minutes.

7. Confirm current-head review, CI, trusted acceptance evidence, branch protection, and guarded merge all pass. Push a new commit once to verify old proof becomes stale.

## Trust boundary

The exercise job runs candidate code with disposable principals. A separate `graphyard-reporting` environment holds the producer credential and publishes only the fixed inventories registered in `scripts/contracts.mjs`, and only for the proof the dispatch selected. A report cannot rename, widen, or shrink the case list its own proof requires. PR code never receives the production Graphyard token.

## Adding a trusted contract

Because a trusted run executes only protected source, a contract must reach protected `main` before any work item may require its proof. Land the harness, its registry entry, and its unprivileged CI job as their own change, gated by review, CI and the proofs that already exist; then require the new proof of later work.

Preparation enforces that order rather than trusting the dispatch. It first resolves the requested proof against the registry in this protected checkout, before any candidate code is fetched. It then fetches the candidate's base commit alone and refuses unless that base already carries the contract's source file, so the change that introduces a contract can never be the change its own trusted proof certifies. Assigning a new proof to the change that introduces it therefore fails closed instead of producing evidence a candidate effectively wrote for itself.

The CI job for the new contract runs the identical fixed inventory against every candidate, so the change that introduces a contract is still executed end to end — it simply publishes no trusted evidence.

`integration:claim-safety` covers API authorization, competing claims, stale epochs, worker evidence trust, and unfinished dependencies. `integration:herdr-recovery` covers [cross-machine lease recovery](herdr.md#automated-recovery-contract). Neither proves arbitrary product behavior or production delivery, and neither replaces the [two-machine operational drill](coordination.md#two-machine-operational-drill) on real hosts.

After this loop succeeds, route further Graphyard work through Graphyard-assigned worktrees. See [development](development.md) for repository rules and [GitHub enforcement](github.md) for the general integration model.
