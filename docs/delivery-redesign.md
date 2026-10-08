<!-- page: Operate Graphyard | 6 | merge writer, rollout. -->
# Delivery redesign

## One rule

Only Graphyard writes to main.

## Flow

1. **Head submission under a lease.** A worker submits a commit (`complete GY-N EPOCH --head SHA`); the lease ends in the same transaction.
2. **One serial merge writer** trial-merges the head onto main, runs build and fast tests on the merged tree, records merge intent, then pushes the exact tested merge commit with the install's deploy key, leased on the tested tip.
3. **Candidates every ~10 merges or 15 quiet minutes.** Main's tip becomes a candidate: UAT serves it, E2E runs, the exact tested commit is promoted. On E2E failure the newest item related to the failing cases is reverted.
4. **One independent reviewer per item.** Sensitive diffs get a blocking review before step 2; the rest a non-blocking review after merge.

## Merge writer

Steps are idempotent; main's sha settles delivery.

## Removed and kept

Removed: GitHub Apps, branch protection, required checks, PR approval, the merge queue, plannedFiles and scope requests, sync-restore, proof-producer sessions, approver agents except for sensitive diffs, docs and module budgets.

Kept: leases and epochs, the transactional ledger, two risk lanes, UAT serving a pinned commit.

## The merger setting

`merger` selects the mode per install, `github` (default) or `control-plane`: an admin-only ledger event, never read from graphyard.json. Read: `graphyard master merger`; set: `graphyard master merger MODE --reason TEXT`; `/api/status` shows `mergeWriter`; `GET`/`POST /api/merger` (admin, `reason`, `Idempotency-Key`). Under `control-plane`, worker launches mint no push credential and bind no keyring proxy; a launch whose merger read fails is refused before any claim and retried, never guessed.

## Rollout

1. **Shadow mode**: heads are trial-merged and fast-tested beside the GitHub gate, nothing written; `master status` `shadowGate` counts agree-pass, agree-fail, shadow-only-fail, shadow-missed, pending; p50/p90; newest ten disagreements. Switch criterion: two weeks with no shadow-passed head reverted by the main guard and every shadow-only failure explained.
2. **Switch** `control-plane`.
3. **Run the Snake pilot.**
4. **After a week**, delete the github-mode gate code.

## Measures

Weekly: defects reaching production (escapes), merge-queue wait, human touches. Deferred until one demands it: pre-merge review for medium risk, batched merge validation, a per-test flake ledger.
