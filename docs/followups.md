<!-- page: Operate Graphyard | 4 | review follow-ups: recorded on the item, retrieved, promoted on demand. -->
# Review follow-ups

An approval's FOLLOW-UP findings are recorded on the approved item, never filed as work; an operator
promotes one on demand.

## Recorded on the item and the pull request

The loop records an approval's follow-ups on its item (`POST /api/work/GY-N/followups`,
`followups.recorded` naming pull request and head):

- Only new findings (by path and text) are added; retries record nothing twice.
- Each follow-up thread gets a reply naming the item and is resolved.

Open legacy follow-up items still take later findings ([machine-filed backlog](master-agent.md#machine-filed-backlog)).

## Retrieving a batch

    graphyard followups GY-N      # GET /api/work/GY-N/followups
    graphyard followups --pr N    # GET /api/followups?pr=N

Findings are numbered from 1, with file, text, thread, pull request, head and promoted item.

## Promoting a finding

    graphyard promote-followup GY-N INDEX

An admin, or an operator agent holding `intent:create`, promotes a finding
(`POST /api/work/GY-N/promote`) to a backlog item that plans its file, depends on the approved item
and requires `manual:review-followup-addressed` (fixed, or declined with a reason). Promotion happens
once; repeating it answers the same item (`"duplicate": true`).
