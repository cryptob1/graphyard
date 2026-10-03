<!-- page: Operate Graphyard | 4 | recorded on item until ship, retrieved, promoted. -->
# Review follow-ups

An approval's FOLLOW-UP findings (beyond criteria) are recorded on the item and held until it ships (`pendingFollowUps`), then filed as its one follow-up item; an operator may promote sooner.

## Recorded on the item and the pull request

The loop records them on the item (`POST /api/work/GY-N/followups`; `followups.recorded`):

- Only new findings (path and text) are added; retries record nothing twice.
- Each thread gets a reply naming the item and is resolved; thread-less findings use the approval's `Follow-up finding:` line.
- Findings are held until ship; later approvals append to the open follow-up item.

## Filed once the item ships

When delivered (and merge passes required suite), the loop files held findings as `Follow-ups from the approved review of GY-N (PR #M)` (`POST /api/work/GY-N/followups` with `{"ship":true}`). Triage judges it in [backlog](master-agent.md#machine-filed-backlog); unshipped items drop on close.

## Retrieving a batch

    graphyard followups GY-N      # GET /api/work/GY-N/followups
    graphyard followups --pr N    # every batch for PR N: GET /api/followups?pr=N

Numbered from 1.

## Promoting a finding

    graphyard promote-followup GY-N INDEX

An admin or operator agent with `intent:create` promotes finding `INDEX` (`POST /api/work/GY-N/promote`) to a backlog item: finding as criterion, file planned, depending on approved item, requiring `manual:review-followup-addressed`. Repeated promotions return `"duplicate": true`.
