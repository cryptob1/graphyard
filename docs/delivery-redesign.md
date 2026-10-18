<!-- page: Operate Graphyard | 6 | merge writer, rollout. -->
# Delivery redesign

## One rule

Only Graphyard writes to main.

## Flow

1. **Head submission under a lease:** `complete GY-N EPOCH --head SHA`; the lease ends in the same transaction.
2. **One serial merge writer** records merge intent, then pushes the exact tested merge commit with the install's deploy key, leased on the tested tip; between them it trial-merges and runs build and fast tests on the merged tree.
3. **Candidates every ~10 merges or 15 quiet minutes.** E2E runs on UAT; the exact tested commit is promoted. E2E failure reverts the newest related item.
4. **One independent reviewer per item.** Sensitive diffs are reviewed before step 2, the rest after merge.

## Merge writer

Oldest first, one in flight: `merge.intent`; merge-commit trial (affected and proof tests; no tests without `scripts/ci-tests.mjs`, build without `package.json`; `web/`, `browser-tests/`, `src/server/routes` changes add `npm run test:browser` (host Chromium); failed probes: runner failures; host-sized, slot-declared shards; one retry on timeout, cancel, host failure; `merge.trial`: `outcome`, `phase`, `reason`, `phases`, `attempts`); `git push --force-with-lease` with `run.mergeWriter.deployKeyFile` alone; `merge.pushed`; fetch; `merge.reconciled` delivers. A moved tip re-trials (`retrials`, 3); an unmoved-tip rejection waits; a failed trial reworks (`mergeWriter.reworks` until confirmed). Reconcile rule: an unpushed intent main's first parent holds delivers, else re-queues. Record keys name persisted attempts: lost replies replay exactly (`mergeWriter.unconfirmed`); reused-key refusals adopt the ledger, then retry anew. `master status`: `mergeWriter.queue`.

## Removed and kept

Removed: GitHub Apps, branch protection, required checks, PR approval, merge queue, plannedFiles and scope requests, sync-restore, proof-producer sessions, approver agents outside sensitive diffs, docs and module budgets, rulesets, auto-merge.

Kept: leases and epochs, the transactional ledger, two risk lanes, UAT on a pinned commit.

## The merger

The control plane is every install's only merge writer: nothing sets another, and old `policy.merger.set` events are never read (`/api/status` `mergeWriter`). Launches get no push credential or keyring proxy. Setup and `doctor` pass `github-app` and `reviewer-app` as `not required (merger: control-plane)`; AGENTS.md: `--head SHA`. Pull-request candidates are observed from the shared object store, queued for the writer.

`POST /api/work/:id/merge-record` (coordinator, `Idempotency-Key`) records each step; `pushed`/`reconciled` name the open intent's merge commit, `reconciled` one main holds, else 409.

## Rollout

1. **Shadow mode**: trials beside the GitHub gate, nothing written; `shadowGate` counts agree-pass, agree-fail, shadow-only-fail, shadow-missed, pending; p50/p90; newest ten disagreements.
2. **Switch** `control-plane`: done, for every install.
3. **Run the Snake pilot.**
4. **After a week**, delete the github-mode gate code.

## Measures

Weekly: defects reaching production (escapes), merge-queue wait, human touches. Deferred until one demands it: pre-merge review for medium risk, batched merge validation, a per-test flake ledger.
