<!-- page: Operate Graphyard | 4 | recorded, retrieved, promoted. -->
# Review follow-ups

An approval's FOLLOW-UP findings (beyond the criteria) are never filed as work (per review or per
item); an operator promotes one on demand.

## Recorded on the item and the pull request

The loop records them on the item (`POST /api/work/GY-N/followups`; `followups.recorded`):

- Only findings the batch lacks (by path and text) are added; retries record nothing twice.
- Each follow-up thread gets a reply naming the item and is resolved; a thread-less finding is on the approval's `Follow-up finding:` line.

## Retrieving a batch

    graphyard followups GY-N      # GET /api/work/GY-N/followups
    graphyard followups --pr N    # every batch for PR N: GET /api/followups?pr=N

Findings are numbered from 1.

## Promoting a finding

    graphyard promote-followup GY-N INDEX

An admin, or operator agent holding `intent:create`, promotes finding `INDEX` (`POST /api/work/GY-N/promote`)
to a backlog item: finding as criterion, its file planned, depending on the approved item, requiring
`manual:review-followup-addressed`. Once only: a repeat answers `"duplicate": true`.
