<!-- page: Operate Graphyard | 2 | App, protection, queue, proofs. -->
# GitHub enforcement

## App permissions

The control-plane App holds (`src/github-permissions.ts`): Actions read and write, rerunning failed jobs on the unchanged candidate; Administration read, inspecting branch protection; Checks read and write, reading CI check runs and publishing `Graphyard / merge` on the exact candidate commit; Contents read and write, reading commits, trees and pull request files and publishing speculative merge-queue tips (the candidate-branch merge commit and its `refs/graphyard/queue/*` binding ref); Issues read, receiving `issue_comment` webhooks carrying review results; Metadata read, reading the managed repository; Pull requests read and write, reading pull requests and reviews and posting review request comments.

A reviewer App never gets Contents: write, Checks, or Administration; workers are not Apps. `graphyard master reviewer setup` creates it (Pull requests write, reads otherwise): Contents read (the code under review), Issues read (`issue_comment` events on the reviewed pull request), Metadata read (the managed repository), Pull requests read and write (the verdict comment). Review tokens last one hour; `SLUG[bot]` approving the head satisfies both.

Grants recheck every five minutes and on 403s; a shortfall (`appPermissions`) holds jobs **not retried** (`integration-held`) until `master browser app-permissions` or `master browser installation-accept` fixes it.

## Require the check

On the base branch require `Graphyard / merge` from this App, `strict` **off**, admin-enforced, no force pushes or deletion, workers without bypass ([repair lane](master-agent.md#repair-lane)); `master browser protection` reconciles it.

The gate requires `GITHUB_CI_APP_IDS` CI checks, current-head approval, trusted passing evidence, a mergeable non-draft PR and the queue head or the [optimistic lane](#optimistic-merges); unknown mergeability is re-read 3 times in 10 s, then refused.

## Merge queue

A failed required check reruns once on the unchanged head before rework or ejection; gate and rework decisions take the newest check-run ID from configured CI Apps, not other Apps' same-named checks. An owed or accepted rerun expires after 15 minutes without a new run; a running check finishes; `master status` lists pending reruns. The App needs Actions: write — preflight diagnoses a missing grant; rerun requests hold until accepted.

Once gated, the candidate's speculative tip on the candidate branch and `refs/graphyard/queue/KEY` binds every check, review and proof; a failed check, requested changes, revoked proof, conflict or rework ejects it back, one conflicting only with entries ahead re-entering unchanged once one lands or leaves. The App passes the check for an authorized head and merge group and asks GitHub to merge (queue, auto-merge or direct); protection decides; withdrawal dequeues. Queueless `CLEAN`, `UNSTABLE` and `HAS_HOOKS` PRs merge at once, head-bound.

### Bindings and carry

Reviews and proofs bind one head, base and policy revision. The queue tip merges moved bases: all carry if the clean merge kept the patch-id, else the approval if no reviewed file changed, disjoint-`scopeFiles` proofs. A republication reads the PR's reviews before force-pushing: the replaced tip's approval carries onto a Graphyard-authored tip over the same author head and patch, the App's own dismissal restoring when observed — never a person's, a moved head, or a changed patch. Carried steps name their ground; CI reruns. GitHub conflicts are test-merged; clean ones log `base.stale-mergeability`.

Before merging, the reviewer App re-posts a carried approval onto the tip: a carried review missing from the PR re-posts the bound reviewer's latest approval of the head the tip was built from, a newer approval of that head re-binding the carry once observed (`review.carry-refreshed`). With none usable the merge reports `mergerefused`: the control plane clears the carried approval (`mergeRefusal.action: rereview`) so the review gate requests a fresh review of the tip at once, and the entry yields the queue head to the next until a fresh approval re-enters it. The same refusal on consecutive cycles past 10 minutes raises an attention naming reason and next step; the loop acts itself, clearing a carried approval or requesting a rework decision (`mergeRefusal.action: rework`) for the approver. Each action fires once per recovery phase, a re-bound carry a phase of its own: never retried for good.

### Parallel tips

`mergeQueue.parallelTips` (master config, default 4, published via `POST /api/merge-queue`) stacked tips test at once; entries merge in order once every tip through theirs passes; each publication wakes successors, re-reading in-flight verdicts. A failing tip ejects its entry once those ahead pass, after any configured failed-check rerun; later tips rebuild.

Each entry validates on its own tip: one CI duration covers four default positions, costing concurrent CI and a discarded suffix on failure; `parallelTips: 1` restores batching; `batchSize` still widens observation and wake depth.

### Optimistic merges

`mergeQueue.optimistic` (default on, independent of `mergeQueue.rerunFailedChecks`): a green entry disjoint from base changes and shared infrastructure lands head-bound, unqueued; a main guard [reverts](master-agent.md#repair-lane) and reopens culprits (`master status`: `optimisticMerge`). Shared infrastructure is the master config's `mergeQueue.optimisticExclude` globs — onboarding product defaults (manifests, lockfiles, CI config, test helpers, schema and migration directories) — so an excluded path never merges optimistically, nor anything whose base changed one since its run; `optimistic: false` turns the lane off.

### Proofs in CI

A protected `pull_request_target` workflow runs on every `graphyard/*` push: **plan** finds the item's `unit:*`/`integration:*` proofs, **exercise** runs one secret-free job on the base-merged candidate, **publish** reports via the `ciRun`-bound [CI producer](deployment.md#ci-producer), queue tips cached; manual proofs stay producer sessions.

## Post-deployment smoke proof

With `"deploySmoke": true` the master dispatches the smoke install once the release serves the merge; failure marks it [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Enforcement boundary

GitHub merges only heads whose required check passed; restrict other merge identities; a lease-losing worker can still push.

## Identity-bound agent review

`reviewProvider: "codex"` accepts only Codex's clean result on the exact head; `agent` requires a registered reviewer App distinct from the author (`github-setup URL --reviewer claude`, listed in `GRAPHYARD_REVIEWER_APPS`), adopted with `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json), replying an approved `graphyard-verdict` comment naming the head; `verdict:usage-limit` or silence fails over.
