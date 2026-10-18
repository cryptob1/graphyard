<!-- page: Operate Graphyard | 6 | merge writer, rollout. -->
# Delivery redesign

## One rule

Only Graphyard writes to main.

## Flow

1. **Head submission under a lease:** `complete GY-N EPOCH --head SHA`; the lease ends in the same transaction.
2. **One serial merge writer** records merge intent, then pushes the exact tested merge commit with the install's deploy key, leased on the tested tip; between them it trial-merges and runs build and fast tests on the merged tree.
3. **Candidates every ~10 merges or 15 quiet minutes.** E2E runs on UAT; the exact tested commit is promoted. On E2E failure the newest item related to the failing cases is reverted.
4. **One independent reviewer per item.** Sensitive diffs get a blocking review before step 2; the rest a non-blocking review after merge.

## Merge writer

Oldest first, one in flight: `merge.intent`; merge-commit trial (affected and proof tests; no tests without `scripts/ci-tests.mjs`, build without `package.json`; failed probes: runner failures; host-sized, slot-declared shards; one retry on timeout, cancel, host failure; `merge.trial`: `outcome`, `phase`, `reason`, `phases`, `attempts`); `git push --force-with-lease` with `run.mergeWriter.deployKeyFile` alone; `merge.pushed`; fetch; `merge.reconciled` delivers. A trial past `run.mergeWriter.trialTimeoutMinutes` (20, at most 120) is killed and retried. A moved tip re-trials (`retrials`, 3); an unmoved-tip rejection waits; a failed trial reworks (`mergeWriter.reworks` until confirmed). Reconcile rule: an unpushed intent main's first parent holds delivers, else re-queues. Record keys name persisted attempts: lost replies replay exactly (`mergeWriter.unconfirmed`); reused-key refusals adopt the ledger, then retry anew. `master status`: `mergeWriter.queue`.

## Removed and kept

Removed: GitHub Apps, branch protection, required checks, PR approval, the merge queue, plannedFiles and scope requests, sync-restore, proof-producer sessions, approver agents outside sensitive diffs, docs and module budgets.

Kept: leases and epochs, the transactional ledger, two risk lanes, UAT on a pinned commit.

## The merger

The control plane is every install's only merge writer: nothing sets another, and old `policy.merger.set` events are never read (`/api/status` `mergeWriter`). Launches get no push credential or keyring proxy; no GitHub branch protection, ruleset or auto-merge is used. Setup and `doctor` pass `github-app` and `reviewer-app` as `not required (merger: control-plane)`; AGENTS.md: `--head SHA`. A pull-request candidate is observed from the shared object store and queued for the writer.

`POST /api/work/:id/merge-record` (coordinator, `Idempotency-Key`) records each step; `pushed`/`reconciled` name the open intent's merge commit, `reconciled` one main holds, else 409.

## Rollout

1. **Shadow mode**: retired (GY-2010). Its gate trialled heads beside GitHub's and wrote nothing; it, `run.shadowGate` and the `shadowGate` report are gone, so the merge writer's trial is the only trial and nothing fetches a worker branch.
2. **Switch** `control-plane`: done, for every install.
3. **Run the Snake pilot.**
4. **Done (GY-2010):** the github-mode API client, App credentials, webhooks, caches, request budget and main guard are deleted; gates read the merge ledger alone, and base failures and flakes come from the writer's trials, never a CI log.

## Measures

Weekly: defects reaching production (escapes), merge-queue wait, human touches. Deferred until one demands it: pre-merge review for medium risk, batched merge validation, a per-test flake ledger.
