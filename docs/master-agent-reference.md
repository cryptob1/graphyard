<!-- page: Operate Graphyard | 7 | commands and trial isolation -->
# Master-agent reference

## Items and human waits

Use `blocked GY-N EPOCH REASON` for a genuine blocker; it commits changes and ends the lease. `master unblock GY-N REASON` clears it. Use `guide park` only for the human's three decisions; `answer GY-N …` records their response. Routine requirements and repair need no human approval.

## Promotion to autonomy

`master promote --admin-token-stdin` provisions the master's operator-agent identity. Workers never receive it.

Use `master reviewer add FILE` to add a review profile. Reviewers post verdicts through the control plane with a token bound to the launch and candidate. Reviewer Apps, installation bindings and App credentials are gone, as are `master reviewer setup` and `bind`. Older configs with `githubAppId` and `mergeMethod` still load.

Run `verify GY-N` in the assigned worktree before submission. After `complete`, Graphyard requests independent review; the merge writer runs required unit and served-head E2E proofs for that head. Workers never submit trusted evidence; earlier-head results cannot satisfy its gates.

## Typed actions

`nextAction` names dispatch, request-review, request-rework, resync, reclaim or merge. `master dispatch GY-N PROFILE` works through normal eligibility and lease checks, including on system-driven items. `master merge` reports that only the loop's writer merges; it performs no hand merge.

## Recovery

`master browser` is removed. If an older control plane reports App permissions or held integration jobs, use `graphyard install --repo OWNER/NAME --plan`, then `--apply`, to replace the retired App integration with the merge writer’s deploy key. `master harness claude|codex --apply` denies remote merges/reviews, token minting and mutating `gh api`.

See [operations](operations.md) and [session recovery](master-agent-sessions.md). Preserve expired attempts' work for redispatch.

A worker stopped on a provider limit notice also keeps its local work before redispatch to another account: uncommitted changes become a WIP commit on its attempt branch, and the next worker's prompt names that commit (or the existing HEAD for a clean tree) to read and bring forward.

### Producer-runtime faults

Unanswered requests try another profile. Never substitute worker evidence for trusted proof.

## Merge trial

Workers check implementation and bound E2E cases before submitting. Independent review judges coverage without waiting for later trusted results. Sensitive changes need approval before the writer serves the merge commit and records required E2E results, then updates main. Earlier-head results cannot satisfy that gate; workers never submit trusted evidence.

A failed candidate trial grounds rework through the merge writer; next-action does not hold it for a base-break refresh.

See [trial checks](delivery.md#merge-trials). Trials use a separate checkout/TMPDIR, fresh HOME beside the short temporary directory to bound nested test socket paths, and bubblewrap masks hiding coordinator credentials and deploy key. Builds, previews and E2E steps share confinement; case steps share a namespace for persistent browsers. Only the push child holds the key. Trials stop after 20 minutes and remove their checkout. Missing test checks are explicit in `master status` and `doctor` (`trialTests`).

The fresh home owns its npm/browser caches. Launcher tooling retains host mise config/data/state/cache paths; explicit `MISE_*_DIR` values win over host XDG/HOME defaults. Credential masks still apply. During install/build, known mise shim startup errors (untrusted config or no Node version) and missing exact node/npm/npx executables use host-failure retry/hold, including bubblewrap `execvp` errors without a spawn cause or signal. Project mise task errors and missing build dependencies such as node-gyp still ground rework. Build refusals include the output tail within the 2,000-character limit.

`master status` also shows `deliverySpeed`, computed at query time from the event ledger for the last 50 merged items: median and p90 minutes from release (`ready` event) to merge and in each stage, each item's attempt count, and the open item longest in its current stage.
