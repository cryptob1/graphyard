<!-- page: Operate Graphyard | 6 | merge writer, rollout. -->
# Delivery redesign

## One rule

Only Graphyard writes to main; workers hold no credential that can, and no GitHub App, protection or Action sits in the merge path.

## Flow

1. **Head submission under a lease.** A worker submits an exact commit from its branch (`complete GY-N EPOCH --head SHA`); the lease ends in the same transaction.
2. **One serial merge writer** trial-merges the head onto main, runs build and fast tests on the merged tree, records merge intent, then pushes the exact tested merge commit with the install's deploy key, leased on the tested tip (moved: re-trial).
3. **Candidates every ~10 merges or 15 quiet minutes.** Main's tip becomes a fixed candidate: UAT serves it, E2E runs, the exact tested commit is promoted ([release](delivery.md#release-candidates)). On E2E failure production stays put, the newest item related to the failing cases ([verification maps](development.md#verification-maps)) is reverted and reopened, and the candidate re-runs.
4. **One independent reviewer per item.** Sensitive diffs, classified from the actual merge delta, get a blocking review before step 2; the rest a non-blocking review after merge, findings becoming follow-up items.

## Merge writer

Steps are idempotent; the sha observed on main settles delivery, not the push's exit.

## Removed and kept

Removed: GitHub Apps, branch protection, required checks, PR approval as merge token, the merge queue, plannedFiles with scope requests and sync-restore, proof-producer sessions, approver agents except for sensitive diffs and the three human decisions, docs and module budgets.

Kept: leases and epochs, the transactional ledger, two risk lanes from the diff, UAT serving a pinned commit, deployment verification.

## The merger setting

`merger` selects the mode per install, `github` (default) or `control-plane`: an admin-only ledger event, never read from graphyard.json, so no worker commit changes who writes main.

## Rollout

1. **Shadow mode**: every candidate head is trial-merged and fast-tested beside the GitHub gate, both verdicts recorded, nothing written. Switch criterion: two weeks with no shadow-passed head reverted by the main guard and every shadow-only failure explained.
2. **Switch** `control-plane`.
3. **Run the Snake pilot.**
4. **After a week of real merges**, delete the github-mode gate code.

## Measures

Weekly: defects reaching production (escapes), merge-queue wait, human touches. Deferred until one demands it: pre-merge review for medium risk, batched merge validation, a per-test flake ledger.
