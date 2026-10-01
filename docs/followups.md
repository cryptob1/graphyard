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

## Retro synthesis

With `GRAPHYARD_INTERVENTION_PATTERNS=1`, each minute's pattern scan groups refusal and rework interventions by cause: a declared refusal shape (`build/out-of-scope-count`), a loop refusal trigger, or a normalised rework reason. A cause reaching the threshold in the window gets drafted artefacts (`retro.drafted`), never applied or filed as work: a standards or criteria wording update, a mechanical check, a producer-method correction, a fault-catalogue entry. An AI admin or operator agent holding `decision:approve` (not a human session, the drafter, or an instance's recorder) approves one, applying it at its registry's next revision (`requirements`, `checks`, `catalogue`) and recording the cause, fingerprint and instances it closes, or refuses it. In force: requirements show as `retroStanding` in `graphyard status GY-N`; a check (`planned-files`, `merges-onto-base`, `checks-passed`) runs on every submission's observed candidate, refusing `complete` (`409`); a catalogue entry files later instances under its fault class (`catalogue` on interventions, `retroCatalogued` on gate refusals) and counts recurrences against itself. Instances in any draft never count again; a recurrence after application is redrafted naming it (`recurredAfter`). Routes: [work commands](protocol/work-commands.md).
