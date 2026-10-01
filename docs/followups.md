<!-- page: Operate Graphyard | 4 | reviewer findings. -->
# Review follow-ups

An independent reviewer's approval may name findings beyond the acceptance criteria, each judged
FOLLOW-UP. Graphyard records them on the approved item, never as backlog or ready work items; an
operator promotes one only on demand.

## Recorded on the item and the pull request

The loop records an approved candidate's follow-ups on its item (`POST /api/work/GY-N/followups`;
a `followups.recorded` event names the pull request and head):

- Each approval adds only findings the batch lacks (by file path and text), so retries record
  nothing twice.
- Each follow-up thread gets a reply naming the item and is resolved; a threadless finding is
  already on the approval's `Follow-up finding:` line.

Open legacy items (`Follow-ups from the approved review of GY-N (PR #M)`) still take later
findings and are [triaged](master-agent.md#machine-filed-backlog).

## Retrieving and promoting

    graphyard followups GY-N                 # GET /api/work/GY-N/followups
    graphyard followups --pr N               # GET /api/followups?pr=N, every batch for PR N
    graphyard promote-followup GY-N INDEX    # POST /api/work/GY-N/promote

Findings, numbered from 1, name file, text, thread, reviewed pull request and head, and any
promoted item. An admin, or an operator agent holding `intent:create`, promotes finding `INDEX`
to a backlog item: the finding as criterion, its file planned, depending on the approved item,
requiring `manual:review-followup-addressed` (addressed in code, or declined with a recorded
reason), which a granted producer may hold. Promotion is serialized, once per finding; a repeat
answers the item it became (`"duplicate": true`). The batch keeps every finding.
