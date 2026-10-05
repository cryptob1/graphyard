<!-- page: Operate Graphyard | 4 | review follow-ups: recorded on the item until it ships, retrieved, promoted on demand. -->
# Review follow-ups

The independent reviewer's approval may name findings beyond an item's acceptance criteria and
judge each FOLLOW-UP. Graphyard records them against the approved item itself and holds them there
until it ships — no work item per review, and none for an item that may still change. Once the
item ships, the findings still standing become its one follow-up item; an operator may promote a
finding to a work item of its own sooner.

## Recorded on the item and the pull request

When the loop holds an approval of an item's candidate, it records the approval's follow-ups on
that item's own record (`POST /api/work/GY-N/followups`, a `followups.recorded` event naming the
pull request and head):

- Every approval of the same item adds only the findings the item's batch does not hold yet,
  deduplicated by file path and finding text. A retried filing records nothing twice.
- On the pull request, each follow-up thread gets a reply naming the item and is resolved; a
  finding with no thread is already on the approval's own `Follow-up finding:` line.
- Nothing is filed while the item has not shipped: the findings are held on it
  (`pendingFollowUps`), listed on its page and under `pendingFollowUps` in `graphyard master status`.
- A parent never has more than one open follow-up item, in any stage: while it has one open
  (backlog, released, in build or beyond), a later approval's findings are appended to that item,
  deduplicated, instead.

## Filed once the item ships

The item ships when it is delivered. The loop then files the held
findings not promoted as one follow-up item, `Follow-ups from the approved review of GY-N (PR #M)`,
depending on nothing (`POST /api/work/GY-N/followups` with `{"ship":true}`), once: a retried filing
answers the same item, and a filing refused with one unchanged client error stops after 10
attempts. The item lands in the backlog, where triage judges it
([machine-filed backlog](master-agent.md#machine-filed-backlog)); triage never judges a follow-up
item whose parent has not shipped.

An item closed without shipping drops the findings it holds, recording why on its record and in
its `work.closed` event; a later approval of it files nothing. A one-time migration folded each open
follow-up item filed before this whose parent had not shipped back onto that parent, closing it as
superseded by the parent; nothing was deleted.

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
keeps every finding. A promoted finding no longer waits on the item: the follow-up item filed when
it ships carries only the findings not promoted.

## Past the review-round cap

An item's review round is one more than its rework rounds (`pipeline.reworkRounds`); `master
status` shows it on each work row as `reviewRound` (`round`, `cap`, `capped`). The cap is
`reviewRoundCap` in `.graphyard/master.json` (default 3). Past it, no review finding sends the
item back to a worker, and the reviewer is told to name each blocking finding — an acceptance
criterion not met, wrong behaviour, a security defect — on a `BLOCKING:` line of its change request,
and every other finding on a `Follow-up finding:` line. Both are read wherever they sit in the body:

- A change request from the reviewer App naming no `BLOCKING:` line: the loop records its
  findings (its `Follow-up finding:` lines, else its paragraphs minus the verdict's judgement and
  thread-summary lines) as this item's follow-ups, withdraws it as the reviewer App, and the same
  head is reviewed again, with no rework. A head is withdrawn once: a second change request on it
  escalates as below.
- One naming a blocking finding, or one Graphyard cannot withdraw (a person's, an agent
  provider's): the loop requests no rework and raises an escalation for an independent approver,
  who decides with `graphyard master decide GY-N rework REASON` or has the head re-reviewed.
