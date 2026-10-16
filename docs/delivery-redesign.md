<!-- page: Operate Graphyard | 6 | merge writer, rollout. -->
# Delivery redesign

## One rule

Only Graphyard writes to main.

## Flow

1. **Head submission under a lease:** `complete GY-N EPOCH --head SHA`; the lease ends in the same transaction.
2. **One serial merge writer** records merge intent, then pushes the exact tested merge commit with the install's deploy key, leased on the tested tip; between them it trial-merges and runs build and fast tests on the merged tree.
3. **Candidates every ~10 merges or 15 quiet minutes.** UAT serves it, E2E runs; the exact tested commit is promoted. On E2E failure the newest item related to the failing cases is reverted.
4. **One independent reviewer per item.** Sensitive diffs get a blocking review before step 2; the rest a non-blocking review after merge.

## Merge writer

Oldest head first: `merge.intent`; trial on the merge commit (affected tests plus proof files; none without `scripts/ci-tests.mjs`, no build without `package.json`; failed probes are runner failures; shards within host cores and memory, declared to later suites; timeout, cancel or host failure retries once; `merge.trial` records `outcome`, `phase`, `reason`, `phases`, `attempts`); `git push --force-with-lease` on the tested tip with `run.mergeWriter.deployKeyFile` (`~/.config/graphyard/<install>/deploy-key`) alone; `merge.pushed`; `merge.reconciled` delivers. A moved tip re-trials (`retrials`, 3); an unmoved-tip rejection waits; a failed trial reworks (`mergeWriter.reworks` until confirmed). Reconcile rule: an unpushed intent main's first parent holds delivers, else re-queues. `master status`: `mergeWriter.queue`.

## Removed and kept

Removed: GitHub Apps, branch protection, required checks, PR approval, the merge queue, plannedFiles and scope requests, sync-restore, proof-producer sessions, approver agents outside sensitive diffs, docs and module budgets.

Kept: leases and epochs, the transactional ledger, two risk lanes, UAT on a pinned commit.

## The merger setting

`merger` selects the mode per install, `github` (legacy, upgrades keep it) or `control-plane` (default): an admin-only ledger event, never read from graphyard.json. `graphyard master merger [MODE --reason TEXT]`, `/api/status` `mergeWriter`, `GET`/`POST /api/merger` (admin, `reason`, `Idempotency-Key`). Under `control-plane` launches get no push credential or keyring proxy; an unreadable merger refuses launch. Setup and `doctor` pass `github-app`, `reviewer-app` and `branch-protection` as `not required (merger: control-plane)`; AGENTS.md says `complete GY-N EPOCH --head SHA`.

`POST /api/work/:id/merge-record` (coordinator only, `Idempotency-Key`) appends a step event (`intent`, `trial`, `pushed`, `reconciled`, `refused`); `pushed`/`reconciled` name the open intent's merge commit, `reconciled` one main holds, else 409.

## Rollout

1. **Shadow mode**: trials beside the GitHub gate, nothing written; `shadowGate` counts agree-pass, agree-fail, shadow-only-fail, shadow-missed, pending; p50/p90; newest ten disagreements. Switch criterion: two weeks with no shadow-passed head reverted by the main guard and every shadow-only failure explained. `POST /api/merger` `control-plane` refuses while any shadow disagreement stands unexplained.
2. **Switch** `control-plane`.
3. **Run the Snake pilot.**
4. **After a week**, delete the github-mode gate code.

## Measures

Weekly: defects reaching production (escapes), merge-queue wait, human touches. Deferred until one demands it: pre-merge review for medium risk, batched merge validation, a per-test flake ledger.
