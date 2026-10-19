<!-- page: Operate Graphyard | 6 | merge writer, rollout. -->
# Delivery redesign

## One rule

Only Graphyard writes to main.

## Flow

1. **Head submission under a lease:** `complete GY-N EPOCH --head SHA`; the lease ends in the same transaction.
2. **One serial merge writer** records merge intent, then pushes the exact tested merge commit with the install's deploy key, leased on the tested tip; between them it trial-merges and runs build and fast tests on the merged tree.
3. **Candidates every ~10 merges or 15 quiet minutes.** The exact tested commit is promoted. On E2E failure the newest item related to the failing cases is reverted.
4. **One independent reviewer per item.** Sensitive diffs get a blocking review before step 2; the rest a non-blocking review after merge.

## Merge writer

Four oldest heads share one trial and push, each delivered at its commit; a failed batch merges singly: `merge.intent`; merge-commit trial (affected and proof tests; no tests without `scripts/ci-tests.mjs`, build without `package.json`; host-sized shards; one retry on timeout, cancel, host failure (`merge.trial`)); `git push --force-with-lease` with `run.mergeWriter.deployKeyFile` alone; `merge.pushed`; fetch; `merge.reconciled` delivers. A moved tip re-trials (`retrials`, 3); an unmoved rejection waits; a conflict or failed trial reworks (`mergeWriter.reworks`). A timed-out head goes alone, last; timed out twice while others pass, it reworks (`trial failed`, the slow files). Reconcile rule: an unpushed intent main's first parent holds delivers, else re-queues. Keys name persisted attempts: lost replies replay (`mergeWriter.unconfirmed`); reused-key refusals adopt the ledger, then retry anew. `master status`: `mergeWriter.queue`.

## Removed and kept

Removed: GitHub Apps, branch protection, required checks, PR approval, merge queue, plannedFiles and scope requests, sync-restore, proof-producer sessions, approver agents outside sensitive diffs, docs and module budgets, rulesets, auto-merge.

Kept: leases and epochs, the transactional ledger, two risk lanes, UAT on a pinned commit.

## The merger

The control plane is every install's only merge writer: nothing sets another, and old `policy.merger.set` events are never read. Launches get no push credential or keyring proxy; setup and `doctor` pass `github-app` and `reviewer-app` as `not required (merger: control-plane)`. Candidates: object store, `Hotfix:`/base-repair first, then oldest item.

`POST /api/work/:id/merge-record` (coordinator, `Idempotency-Key`) records each step; `pushed`/`reconciled` name the open intent's merge commit, else 409.

## Rollout

1. **Shadow mode**: trials beside the GitHub gate, nothing written; done, and deleted (GY-2087).
2. **Switch** `control-plane`: done, for every install.
3. **Run the Snake pilot.**
4. **After a week**, delete the github-mode gate code.

## Measures

Weekly: defects reaching production (escapes), merge-queue wait, human touches. Deferred until one demands it: pre-merge review for medium risk, a per-test flake ledger.
