<!-- page: Operate Graphyard | 4 | review follow-ups: recorded on the item, retrieved, promoted on demand. -->
# Review follow-ups

An approval's FOLLOW-UP findings (beyond the criteria) are never filed as work (per review or per
item); an operator promotes one on demand.

## Recorded on the item and the pull request

The loop records them on the item (`POST /api/work/GY-N/followups`; `followups.recorded` names pull
request and head):

- Only findings the batch lacks (by path and text) are added; retries record nothing twice.
- Each follow-up thread gets a reply naming the item and is resolved; a thread-less finding is on the approval's `Follow-up finding:` line.
- No backlog item, so no ready-stage item without implementation.

Open legacy items (`Follow-ups from the approved review of GY-N (PR #M)`) still take later findings, triaged as before ([machine-filed backlog](master-agent.md#machine-filed-backlog)).

## Retrieving a batch

    graphyard followups GY-N      # GET /api/work/GY-N/followups
    graphyard followups --pr N    # every batch for PR N: GET /api/followups?pr=N

Findings, numbered from 1: file, text, thread, reviewed pull request and head, promoted item.

## Promoting a finding

    graphyard promote-followup GY-N INDEX

An admin, or operator agent holding `intent:create`, promotes finding `INDEX` (`POST /api/work/GY-N/promote`)
to a backlog item: finding as criterion, its file planned, depending on the approved item, requiring
`manual:review-followup-addressed` (addressed in code, or declined with a recorded reason; a producer
session may hold it once granted). Serialized, once only: the batch marks the item; a repeat answers
it (`"duplicate": true`). The batch keeps every finding.
