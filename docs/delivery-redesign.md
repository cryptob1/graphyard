<!-- page: Operate Graphyard | 6 | merge writer, rollout. -->
# Delivery redesign

## One rule

Only Graphyard writes to main.

## Flow

1. **Head submission under a lease.** A worker submits a commit (`complete GY-N EPOCH --head SHA`); the lease ends in the same transaction.
2. **One serial merge writer** builds and fast-tests the merged tree, then pushes that exact commit leased on the tested tip.
3. **Candidates every ~10 merges or 15 quiet minutes.** UAT serves it, E2E runs; the exact tested commit is promoted. E2E failure reverts the newest item related to the failing cases.
4. **One independent reviewer per item.** Sensitive diffs: a blocking review before step 2; the rest non-blocking after merge.

## Merge writer

Oldest head first, one in flight: `merge.intent`; trial on the merge commit (affected tests plus proof files; none without `scripts/ci-tests.mjs`, no build without `package.json`; failed probes are runner failures; tests in parallel shards on half the cores; `phases` times each phase; a timeout, cancel or host failure retries once, then records phase and reason); `git push --force-with-lease` on the tested tip with `run.mergeWriter.deployKeyFile` (`~/.config/graphyard/<install>/deploy-key`) alone; `merge.pushed`; fetch; `merge.reconciled` delivers. A moved tip re-trials (`retrials`, 3); a push rejected on an unmoved tip waits; a failed trial reworks (`mergeWriter.reworks` until confirmed). Reconcile rule: an unpushed intent main's first parent holds delivers, else re-queues. `master status`: `mergeWriter.queue`.

## Removed and kept

Removed: GitHub Apps, branch protection, required checks, PR approval, the merge queue, plannedFiles and scope requests, sync-restore, proof-producer sessions, approver agents except for sensitive diffs, docs and module budgets.

Kept: leases and epochs, the transactional ledger, two risk lanes, UAT on a pinned commit.

## The merger setting

`merger` selects the mode per install, `github` (default) or `control-plane`: an admin-only ledger event, never read from graphyard.json. `graphyard master merger [MODE --reason TEXT]`, `/api/status` `mergeWriter`, `GET`/`POST /api/merger` (admin, `reason`, `Idempotency-Key`). Under `control-plane` launches get no push credential or keyring proxy; an unreadable merger refuses launch. Setup and `doctor` pass `github-app`, `reviewer-app` and `branch-protection` as `not required (merger: control-plane)`; AGENTS.md says `complete GY-N EPOCH --head SHA`.

`POST /api/work/:id/merge-record` (coordinator only, `Idempotency-Key`) appends one event per step (`intent`, `trial`, `pushed`, `reconciled`, `refused`); `pushed`/`reconciled` name the open intent's merge commit, `reconciled` one main holds, else 409.

## Rollout

1. **Shadow mode**: trials beside the GitHub gate, nothing written; `shadowGate` counts agree-pass, agree-fail, shadow-only-fail, shadow-missed, pending; p50/p90; newest ten disagreements. Switch criterion: two weeks with no shadow-passed head reverted by the main guard and every shadow-only failure explained. `POST /api/merger` `control-plane` refuses while any shadow disagreement stands unexplained.
2. **Switch** `control-plane`.
3. **Run the Snake pilot.**
4. **After a week**, delete the github-mode gate code.

## Measures

Weekly: defects reaching production, merge-queue wait, human touches. Deferred until needed: pre-merge review for medium risk, batched merge validation, a per-test flake ledger.
