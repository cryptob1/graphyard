<!-- page: Operate Graphyard | 4 | pending findings filed when the approved item ships. -->
# Review follow-ups

An approval's FOLLOW-UP findings stay on the approved item until it ships (`pendingFollowUps`), then file as one backlog item: `Follow-ups from the approved review of GY-N (PR #M)` (`POST /api/work/GY-N/followups` with `{"ship":true}`).

## Recorded on the item and the pull request

The loop records new findings deduplicated by path and text (`followups.recorded` names PR and head), and replies to and resolves each follow-up thread on GitHub. An item closed without shipping drops its findings.

## Retrieving a batch

    graphyard followups GY-N      # GET /api/work/GY-N/followups
    graphyard followups --pr N    # GET /api/followups?pr=N

Findings are numbered from 1: file, text, thread, pull request, head, promoted item.

## Promoting a finding

    graphyard promote-followup GY-N INDEX

An admin or `intent:create` operator agent (`POST /api/work/GY-N/promote`) makes a backlog item planning the file, depending on the approved item and requiring `manual:review-followup-addressed` (fixed, or declined with a reason). Repeats return it (`"duplicate": true`).
