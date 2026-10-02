<!-- page: Operate Graphyard | 4 | review follow-ups: recorded on the item, retrieved, promoted on demand. -->
# Review follow-ups

The independent reviewer's approval may name findings beyond an item's acceptance criteria and
judge each FOLLOW-UP. Graphyard records them against the approved item itself — never as a work
item, neither one per review nor one per item — and an operator promotes a finding to a work item
only on demand.

## Recorded on the item and the pull request

When the loop holds an approval of an item's candidate, it records the approval's follow-ups on
that item's own record (`POST /api/work/GY-N/followups`, a `followups.recorded` event naming the
pull request and head):

- Every approval of the same item adds only the findings the item's batch does not hold yet,
  deduplicated by file path and finding text. A retried filing records nothing twice.
- On the pull request, each follow-up thread gets a reply naming the item and is resolved; a
  finding with no thread is already on the approval's own `Follow-up finding:` line.
- Nothing is filed: the backlog gains no item, and no ready-stage item carries no implementation.

Follow-up items filed before this (`Follow-ups from the approved review of GY-N (PR #M)`) still
take a later approval's findings while open, and are triaged as before
([machine-filed backlog](master-agent.md#machine-filed-backlog)).

## Retrieving a batch

    graphyard followups GY-N
    graphyard followups --pr N

The first answers item `GY-N`'s batch (`GET /api/work/GY-N/followups`); the second every batch
recorded for pull request `N` (`GET /api/followups?pr=N`). Each finding is numbered from 1 and
names its file, text, the thread it was raised on, the pull request and head its approval
reviewed, and the item it was promoted to, if any.

## Promoting a finding

    graphyard promote-followup GY-N INDEX

An operator (an admin, or an operator agent holding `intent:create`) promotes finding `INDEX` of
`GY-N`'s batch (`POST /api/work/GY-N/promote`) to an ordinary work item of its own, in the
backlog. It carries the finding as its criterion, plans the finding's file, depends on the
approved item, and requires `manual:review-followup-addressed` — the finding is addressed in
code, or declined with a recorded reason — which a producer session may hold once granted.

A finding is promoted once: promotions of one finding are serialized, the batch marks it with
the item it became, and repeating the command answers that item (`"duplicate": true`). The batch
keeps every finding; the rest wait until an operator promotes them.

## Past the review-round cap

An item's review round is one more than its rework rounds (`pipeline.reworkRounds`); `master
status` shows it on each work row as `reviewRound` (`round`, `cap`, `capped`). The cap is
`reviewRoundCap` in `.graphyard/master.json` (default 3). Past it, no review finding sends the
item back to a worker, and the reviewer is told to name each blocking finding — an acceptance
criterion not met, wrong behaviour, a security defect — on a `BLOCKING:` line of its change request:

- A change request from the reviewer App naming no `BLOCKING:` line: the loop records its
  findings as this item's follow-ups, withdraws it as the reviewer App, and the same head is
  reviewed again, with no rework.
- One naming a blocking finding, or one Graphyard cannot withdraw (a person's, an agent
  provider's): the loop requests no rework and raises an escalation for an independent approver,
  who decides with `graphyard master decide GY-N rework REASON` or has the head re-reviewed.
