<!-- page: Operate Graphyard | 4 | pending findings filed when the approved item ships. -->
# Review follow-ups

An approval's FOLLOW-UP findings stay on the approved item until it ships (`pendingFollowUps`), then file as one backlog item: `Follow-ups from the approved review of GY-N (PR #M)` (`POST /api/work/GY-N/followups` with `{"ship":true}`).

## Recorded on the item and the pull request

The loop records new findings deduplicated by path and text (`followups.recorded` names PR and head), and replies to and resolves each follow-up thread on GitHub. An item closed without shipping drops its findings.

## Retrieving a batch

    graphyard followups GY-N      # GET /api/work/GY-N/followups
    graphyard followups --pr N    # GET /api/followups?pr=N

Findings are numbered from 1.

## Promoting a finding

    graphyard promote-followup GY-N INDEX

An admin or `intent:create` operator agent (`POST /api/work/GY-N/promote`) makes a backlog item planning the file, depending on the approved item and requiring `manual:review-followup-addressed` (fixed, or declined with a reason). Repeats return it (`"duplicate": true`); a promoted finding leaves only unpromoted findings for ship.

## Past the review-round cap

An item's review round is its rework rounds plus one; `master status` shows `reviewRound` (`round`, `cap`, `capped`); the cap is `reviewRoundCap` in `.graphyard/master.json` (default 3). Past it, no finding sends an item back to a worker: reviewers name each blocking finding on a `BLOCKING:` line, and non-blocking ones on a `Follow-up finding:` line.

- A change request without a `BLOCKING:` line records findings as follow-ups and withdraws the verdict; the head is reviewed again without rework (withdrawn once; a repeat escalates).
- One naming a blocking finding, or one Graphyard cannot withdraw, raises an escalation for an independent approver (`graphyard master decide GY-N rework REASON`).
