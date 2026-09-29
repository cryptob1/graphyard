<!-- page: Operate Graphyard | 4 | the machine-filed backlog: batching, retrieval, triage, promotion. -->
# Review follow-ups

The independent reviewer's approval may name findings beyond an item's acceptance criteria and
judge each FOLLOW-UP. Graphyard records them as a machine-filed backlog item on its own — never
as one dispatchable work item per review.

## One batch per parent

Every follow-up of one approved item (the parent) lives in one backlog item, titled
`Follow-ups from the approved review of GY-N (PR #M)`:

- The first approval files the batch. It starts in the backlog stage, not ready: it awaits
  triage and is never a ready-stage item that carries no implementation.
- Each later approval of the same parent appends its new findings to that same batch
  (`POST /api/work/GY-N/followups`), deduplicated by file path and finding text, and recorded in
  the item's history. No second item is filed while one is open.
- The batch depends on the parent, so it is never dispatched against a base that lacks the
  reviewed change.

## Triaging a batch

The loop's triage step judges every machine-filed item within 24 hours: release it at a
priority, close it (superseded by a delivered item, or not worth doing), or merge it into
another open item. A release applies at once; a closure or merge is applied only once an
independent approver approves it. Past 24 hours untriaged, `master status` raises attention.

## Retrieving a batch

- By item: `graphyard status GY-N` answers the batch itself;
  `graphyard work events GY-N` answers its history.
- By PR: the batch title names the parent and the pull request
  (`Follow-ups from the approved review of GY-N (PR #M)`), so a filter over
  `graphyard work list` finds every batch of one pull request.

## Promoting a finding

    graphyard work promote-followup GY-N INDEX

An operator promotes one finding of batch `GY-N` (1-based, in the order the batch lists its
findings) to an ordinary work item of its own. The promoted item carries the finding as its
criterion, plans the finding's file, depends on the parent, and requires the proof
`manual:review-followup-addressed` — the finding is addressed in code, or declined with a
recorded reason — which a producer session may hold once the operator grants it.

The promotion is one transaction and cannot file a duplicate: the promoted item's title names
the batch and the finding index, so repeating the command finds the item the first run created,
and the create itself is sent under a deterministic idempotency key the server replays. The
batch keeps every finding; its triage decides the rest as before. A promoted item is an
ordinary item, not a second follow-up item of the parent.
