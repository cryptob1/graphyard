<!-- page: Operate Graphyard | 4 | held until ship, promoted. -->
# Review follow-ups

An approval's FOLLOW-UP findings (beyond criteria) are recorded on the item and held until it ships (`pendingFollowUps`), then filed as its one follow-up item; an operator may promote sooner.

## Recorded on the item and the pull request

The loop records them (`POST /api/work/GY-N/followups`; `followups.recorded`) idempotently, replying to and resolving each thread.

## Filed once the item ships

On delivery, held findings are filed as `Follow-ups from the approved review of GY-N (PR #M)` (`{"ship":true}`), triaged in the [backlog](master-agent.md#machine-filed-backlog).

## Retrieving a batch

    graphyard followups GY-N      # GET /api/work/GY-N/followups (indexed from 1)
    graphyard followups --pr N    # every batch for PR N: GET /api/followups?pr=N

## Promoting a finding

    graphyard promote-followup GY-N INDEX

An operator (`intent:create`) promotes finding `INDEX` (`POST /api/work/GY-N/promote`) to a backlog item: finding as criterion, file planned, requiring `manual:review-followup-addressed`. Repeating answers that item (`"duplicate": true`). A promoted finding no longer waits on ship.

## Past the review-round cap

Review round is `pipeline.reworkRounds + 1`; `master status` shows `reviewRound` (`round`, `cap`, `capped`). The cap is `reviewRoundCap` in `.graphyard/master.json` (default 3). Past it, no review finding reworks the item. Reviewers name blocking findings on `BLOCKING:` lines, non-blocking on `Follow-up finding:` lines:

- Without `BLOCKING:`, reviewer App findings become follow-ups, the review is withdrawn, and the head is re-reviewed without rework (withdrawn once per head; a second escalates).
- With `BLOCKING:` or a non-withdrawable reviewer: no rework; escalates for an approver (`graphyard master decide GY-N rework REASON`).
