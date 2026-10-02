<!-- page: Operate Graphyard | 4 | review follow-ups: recorded on the item, retrieved, promoted on demand. -->
# Review follow-ups

An approval's FOLLOW-UP findings stay on the approved item, never filed as work, until promoted.

## Recorded on the item and the pull request

The loop records new findings, by path and text (`POST /api/work/GY-N/followups`; `followups.recorded` names PR and head), and replies to and resolves each follow-up thread. Open legacy follow-up items still take findings ([backlog](master-agent.md#machine-filed-backlog)).

## Retrieving a batch

    graphyard followups GY-N      # GET /api/work/GY-N/followups
    graphyard followups --pr N    # GET /api/followups?pr=N

Findings are numbered from 1: file, text, thread, pull request, head, promoted item.

## Promoting a finding

    graphyard promote-followup GY-N INDEX

An admin or `intent:create` operator agent (`POST /api/work/GY-N/promote`) makes a backlog item planning the file, depending on the approved item and requiring `manual:review-followup-addressed` (fixed, or declined with a reason). Repeats return it (`"duplicate": true`).
