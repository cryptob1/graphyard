<!-- page: Operate Graphyard | 4 | held until ship, promoted. -->
# Review follow-ups

An approval's FOLLOW-UP findings (beyond criteria) are recorded on the item and held until it ships (`pendingFollowUps`), then filed as its one follow-up item; an operator may promote sooner.

## Recorded, then filed on ship

The loop records them idempotently (`POST /api/work/GY-N/followups`; `followups.recorded`), resolving each thread. On delivery they are filed as `Follow-ups from the approved review of GY-N (PR #M)` (`{"ship":true}`), triaged in the [backlog](master-agent.md#machine-filed-backlog).

## Retrieving a batch

    graphyard followups GY-N      # GET /api/work/GY-N/followups (indexed from 1)
    graphyard followups --pr N    # every batch for PR N: GET /api/followups?pr=N

## Promoting a finding

    graphyard promote-followup GY-N INDEX

An operator (`intent:create`) promotes finding `INDEX` (`POST /api/work/GY-N/promote`) to a backlog item requiring `manual:review-followup-addressed`, no longer waiting on ship; repeats answer `"duplicate": true`.

## Past the review-round cap

Review round is `pipeline.reworkRounds + 1` (`master status` `reviewRound`); past `reviewRoundCap` (`.graphyard/master.json`, default 3) no finding reworks. Reviewers mark `BLOCKING:` and `Follow-up finding:` lines:

- Without `BLOCKING:`, findings become follow-ups and the review is withdrawn and redone without rework (once per head; a second escalates).
- With `BLOCKING:` or a non-withdrawable reviewer: no rework; escalates for an approver (`graphyard master decide GY-N rework REASON`).
