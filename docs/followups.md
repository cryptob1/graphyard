<!-- page: Operate Graphyard | 4 | review follow-ups: recorded on the item, retrieved, promoted on demand. -->
# Review follow-ups

An approval's FOLLOW-UP findings stay on the approved item, never filed as work, until promoted.

## Recorded on the item and the pull request

The loop records them (`POST /api/work/GY-N/followups`,
`followups.recorded` naming pull request and head):

- Only new findings (by path and text) are added.
- Each follow-up thread gets a reply naming the item and is resolved.

Open legacy follow-up items still take findings ([backlog](master-agent.md#machine-filed-backlog)).

## Retrieving a batch

    graphyard followups GY-N      # GET /api/work/GY-N/followups
    graphyard followups --pr N    # GET /api/followups?pr=N

Findings are numbered from 1: file, text, thread, pull request, head, promoted item.

## Promoting a finding

    graphyard promote-followup GY-N INDEX

An admin, or an operator agent holding `intent:create`, promotes a finding
(`POST /api/work/GY-N/promote`) to a backlog item that plans its file, depends on the approved item
and requires `manual:review-followup-addressed` (fixed, or declined with a reason). Repeats answer
the same item (`"duplicate": true`).
