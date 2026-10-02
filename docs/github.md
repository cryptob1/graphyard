<!-- page: Operate Graphyard | 2 | App, protection, queue, proofs. -->
# GitHub enforcement

## App permissions

Control-plane App (`src/github-permissions.ts`):

| Permission | Access | Needed to |
| --- | --- | --- |
| Actions | Read and write | rerun failed workflow jobs on the unchanged candidate (failed CI reruns) |
| Administration | Read | inspect branch protection (pull request observation) |
| Checks | Read and write | read CI check runs (pull request observation); publish `Graphyard / merge` on the exact candidate commit (the required check) |
| Contents | Read and write | read commits, trees and pull request files (pull request observation); publish speculative merge-queue tips: the merge commit on the candidate branch and the `refs/graphyard/queue/*` ref that binds it (the merge queue) |
| Issues | Read | receive `issue_comment` webhooks carrying review results (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | read pull requests and reviews (pull request observation); post review request comments (review dispatch) |

A reviewer App is never granted Contents: write, Checks, or Administration; worker identities are not Apps at all. It holds:

| Permission | Access | Needed to |
| --- | --- | --- |
| Contents | Read | read the code under review (pull request observation) |
| Issues | Read | follow `issue_comment` events on the reviewed pull request (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | post the verdict comment (review dispatch) |

`master reviewer setup` creates it (Pull requests write); review tokens last one hour. Grants recheck every five minutes and on 403s; a shortfall (`appPermissions`) holds jobs **not retried** (`integration-held`) until `master browser app-permissions` or `master browser installation-accept`.

## Require the check

Require `Graphyard / merge` from the control-plane App on the base branch: `strict` **off**, admin-enforced, no force pushes or deletion (`master browser protection` reconciles). It needs green `GITHUB_CI_APP_IDS` and protection-required checks, current-head approval, trusted evidence, a mergeable non-draft PR, and queue head or [optimistic lane](#optimistic-merges). Restrict other merge identities; lease-less workers still push.

## Merge queue

A failed required check reruns once on the unchanged head (newest configured-CI-App run; without Actions: write preflight diagnoses it and requests hold), lapsing after 15 runless minutes. Its workflow run queued or in progress is a runner wait (no new head owed); one not found is requested again.

The speculative tip, pushed onto the candidate branch and `refs/graphyard/queue/KEY`, binds every check, review and proof; failure, requested changes, revoked proof, conflict or rework ejects the entry; one conflicting only with entries ahead of it re-enters unchanged once one lands or leaves. Withdrawal dequeues; queueless `CLEAN`/`UNSTABLE`/`HAS_HOOKS` PRs merge at once, head-bound; `BLOCKED` auto-merge past ten minutes raises `merge-stalled` naming GitHub's blocker.

### Bindings and carry

Reviews and proofs bind a head, base and policy revision; on a moved base all carry if the patch-id held; else the approval carries if no reviewed file changed, as do proofs with disjoint `scopeFiles`. A republished tip of the same head and patch keeps it; a person's approval never carries.

Before merging, the reviewer App re-posts a carried approval onto the tip: a carried review missing from the PR re-posts the bound reviewer's latest approval of the tip's reviewed head, a newer approval of that head re-binding the carry once observed (`review.carry-refreshed`). With none usable the merge reports `mergerefused`: the control plane clears the carried approval (`mergeRefusal.action: rereview`), the review gate requests a fresh review at once, and the entry yields the head to the next until a fresh approval re-enters. The same refusal on consecutive cycles past 10 minutes raises an attention naming reason and next step; the loop acts itself, clearing a carried approval or requesting the rework decision (`mergeRefusal.action: rework`), which an approver judges in the high [risk lane](how-graphyard-works.md#risk-lanes) and which is applied as requested in low or medium. Each action fires once per recovery phase, a re-bound carry a phase of its own: never retried for good.

### Parallel tips

`mergeQueue.parallelTips` (default 4; `POST /api/merge-queue`) tips test at once, merging in order once all tips through theirs pass (`1` batches); a failing tip ejects its entry once those ahead pass, rebuilding later ones. Failing only `unit:docs-word-budget` ejects the first entry whose running total exceeds the budget; those ahead still merge ([development](development.md#documentation)).

### Optimistic merges

`mergeQueue.optimistic` (default on, `false` disables): a green entry disjoint from base changes lands unqueued unless it, or its base since its run, touched a `mergeQueue.optimisticExclude` (shared-infrastructure) glob; a main guard [reverts](master-agent.md#repair-lane) and reopens culprits (`master status`: `optimisticMerge`).

### Pre-merge gate and release-candidate validation

The required pre-merge set is `typecheck` and `test` (`.github/workflows/ci.yml`): build, docs check, Node and browser suites, bounded to finish in under ten minutes. Soak and timing-budget files (`releaseCandidateTests` in `scripts/ci-tests.mjs`), container acceptance and recovery and the Helm chart never run on a pull request: `.github/workflows/release-candidate.yml` runs them on one pinned SHA (its `sha` input or a pushed `rc-*` tag).

### Proofs in CI

A protected `pull_request_target` workflow on each `graphyard/*` push: **plan** finds `unit:*`/`integration:*` proofs, **exercise** runs each secret-free on the base-merged candidate, **publish** reports via the [CI producer](deployment.md#ci-producer). Queue tips are cached. Manual proofs stay producer sessions.

`"deploySmoke": true` smoke-installs once production serves the merge; failure marks it [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Identity-bound agent review

`reviewProvider: "codex"` accepts only Codex's clean result on the exact head. `agent` needs a non-author reviewer App (`github-setup URL --reviewer claude`, in `GRAPHYARD_REVIEWER_APPS`) adopted by `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json); it approves by `graphyard-verdict` comment on the head.
