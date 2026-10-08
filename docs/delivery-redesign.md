<!-- page: Operate Graphyard | 6 | merge writer, rollout. -->
# Delivery redesign

## One rule

Only Graphyard writes to main.

## Flow

1. **Head submission under a lease.** A worker submits a commit (`complete GY-N EPOCH --head SHA`); the lease ends in the same transaction.
2. **One serial merge writer** trial-merges the head onto main, runs build and fast tests on the merged tree, records merge intent, then pushes the exact tested merge commit with the install's deploy key, leased on the tested tip (moved: re-trial).
3. **Candidates every ~10 merges or 15 quiet minutes.** Main's tip becomes a fixed candidate: UAT serves it, E2E runs, the exact tested commit is promoted. On E2E failure the newest item related to the failing cases is reverted and reopened.
4. **One independent reviewer per item.** Sensitive diffs, classified from the merge delta, get a blocking review before step 2; the rest a non-blocking review after merge, findings becoming follow-ups.

## Merge writer

Steps are idempotent; main's observed sha settles delivery.

## Removed and kept

Removed: GitHub Apps, branch protection, required checks, PR approval, the merge queue, plannedFiles and scope requests, sync-restore, proof-producer sessions, approver agents except for sensitive diffs, docs and module budgets.

Kept: leases and epochs, the transactional ledger, two risk lanes, UAT serving a pinned commit.

## The merger setting

`merger` selects the mode per install, `github` (default) or `control-plane`: an admin-only ledger event, never read from graphyard.json.

## Rollout

1. **Shadow mode**: every head is trial-merged and fast-tested beside the GitHub gate, verdicts recorded, nothing written. `master status` `shadowGate` reports counts per outcome (agree-pass, agree-fail, shadow-only-fail, shadow-missed, pending), p50/p90 trial time and the newest ten disagreements. Switch criterion: two weeks with no shadow-passed head reverted by the main guard (no shadow-missed) and every shadow-only failure explained.
2. **Switch** `control-plane`.
3. **Run the Snake pilot.**
4. **After a week of real merges**, delete the github-mode gate code.

## Measures

Weekly: defects reaching production (escapes), merge-queue wait, human touches. Deferred until one demands it: pre-merge review for medium risk, batched merge validation, a per-test flake ledger.
