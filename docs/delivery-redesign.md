<!-- page: Operate Graphyard | 6 | merge writer, rollout. -->
# Delivery redesign

Operator-approved 2026-10-08; github mode works until the [rollout](#rollout) retires it.

## One rule

Only Graphyard writes to main; workers hold no credential that can, and no GitHub App, protection or Action sits in the merge path.

## Flow

1. **Head submission under a lease.** A worker submits an exact commit from its branch (`complete GY-N EPOCH --head SHA`); the lease ends in the same transaction.
2. **One serial merge writer** trial-merges the head onto main in a credential-free worktree, runs build and fast tests on the merged tree, records merge intent, then pushes the exact tested merge commit with the install's deploy key, leased on the tested tip (moved: re-trial); a failed trial reworks the item with the recorded reason.
3. **Candidates every ~10 merges or 15 quiet minutes.** Main's tip becomes a fixed candidate: UAT serves it, E2E runs, the exact tested commit is promoted and production verified ([release](delivery.md#release-candidates)). On E2E failure production stays put, the newest item related to the failing cases ([verification maps](development.md#verification-maps), else newest first) is reverted and reopened, and the candidate re-runs.
4. **One independent reviewer per item** (independent by identity, permissions and participation, never provider). Sensitive diffs, classified from the actual merge delta (renames, CI configuration, dependencies; unknown is sensitive), get a blocking review before step 2; the rest a non-blocking review after merge, findings becoming follow-up items.

## Merge writer

Intent, trial, push, pushed, fetch, reconciled, each idempotent; the sha observed on main settles delivery, not the push's exit status. An unexplained commit on main freezes promotion; nothing auto-reverts.

## Removed and kept

Removed: GitHub Apps, branch protection, required checks, PR approval as merge token, the merge queue, plannedFiles with scope requests and sync-restore, proof-producer sessions, approver agents except for sensitive diffs and the three human decisions, docs and module budgets, auto-revert on main. Tests still run in a credential-free executor with their criterion bindings and protected acceptance definitions. Pull requests and Actions stay optional.

Kept: leases and epochs, the transactional ledger, two risk lanes from the diff, UAT serving a pinned commit, deployment verification, Herdr, the dashboard.

## The merger setting

`merger` selects the mode per install, `github` (default) or `control-plane`: an admin-only ledger event, never read from graphyard.json, so no worker commit changes who writes main.

## Rollout

1. **Shadow mode, about two weeks**: every candidate head is trial-merged and fast-tested beside the GitHub gate, both verdicts recorded, nothing written. Switch criterion: two weeks with no shadow-passed head reverted by the main guard and every shadow-only failure explained.
2. **Switch** the install setting to `control-plane`.
3. **Run the Snake pilot** on the new flow.
4. **After a week of real merges**, delete the github-mode gate code.

A known-good coordinator stays outside the candidate under test.

## Measures

Weekly: defects reaching production (escapes), merge-queue wait, human touches; a control is added only when one worsens. Deferred until one demands it: pre-merge review for medium risk, batched merge validation, a per-test flake ledger.
