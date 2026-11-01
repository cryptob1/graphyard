<!-- page: Operate Graphyard | 7 | commands and trial isolation -->
# Master-agent reference

## Items and human waits

Use `blocked GY-N EPOCH REASON` for a genuine blocker; it commits changes and ends the lease. `master unblock GY-N REASON` clears it. Use `guide park` only for the human's three decisions; `answer GY-N …` records their response. Routine requirements and repair need no human approval.

## Promotion to autonomy

`master promote --admin-token-stdin` provisions the master's operator-agent identity. Workers never receive it.

## GitHub administration through the browser

Only the [deploy key](install.md#step-3-deploy-key) is needed. Legacy `master browser app-permissions|installation-accept|capture` commands refuse without their old credential. `master harness claude|codex --apply` denies remote merges/reviews, token minting and mutating `gh api`.

## Typed actions

`nextAction` names dispatch, request-review, request-rework, resync, reclaim or merge. `master dispatch GY-N PROFILE` works through normal eligibility and lease checks, including on system-driven items. `master merge` reports that only the loop's writer merges; it performs no hand merge.

## Recovery

See [operations](operations.md) and [session recovery](master-agent-sessions.md). Preserve expired attempts' work for redispatch.

### Producer-runtime faults

Unanswered requests try another profile. Never substitute worker evidence for trusted proof.

## Merge trial

A failed candidate trial grounds rework through the merge writer; next-action does not hold it for a base-break refresh.

See [trial checks](delivery.md#merge-trials). Trials use a separate checkout/TMPDIR, fresh HOME and bubblewrap masks hiding coordinator credentials and deploy key. Builds, previews and E2E steps share confinement; case steps share a namespace for persistent browsers. Only the push child holds the key. Trials stop after 20 minutes and remove their checkout. Missing test checks are explicit in `master status` and `doctor` (`trialTests`).
