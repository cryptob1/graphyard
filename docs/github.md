<!-- page: Operate Graphyard | 2 | App, protection, queue, proofs. -->
# GitHub enforcement

## App permissions

Control-plane App (`src/github-permissions.ts`):

| Permission | Access | Needed to |
| --- | --- | --- |
| Actions | Read and write | rerun failed workflow jobs on the unchanged candidate (failed CI reruns) |
| Administration | Read | inspect branch protection (pull request observation) |
| Checks | Read and write | read CI check runs (pull request observation); publish `Graphyard / merge` and `graphyard/landable` on the exact candidate commit (the required checks) |
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

Require `Graphyard / merge` and `graphyard/landable` ([landability](coordination.md)) from the control-plane App on the base branch: `strict` **off**, admin-enforced, no force pushes or deletion; `master protection --apply` and `master browser protection` reconcile both. The gate requires green `GITHUB_CI_APP_IDS` and protection checks, current-head approval, trusted evidence, a mergeable non-draft PR, and queue head or [optimistic lane](#optimistic-merges). Restrict other merge identities; lease-less workers still push.

## Merge queue

A failed required check reruns once on the unchanged head ([flaky checks](operations-reference.md#flaky-ci-check)), lapsing after 15 runless minutes.

The speculative tip, pushed onto the candidate branch once and `refs/graphyard/queue/KEY`, binds every check, review and proof; failure, requested changes, revoked proof, conflict or rework ejects. An entry conflicting only with entries ahead of it re-enters unchanged once one lands or leaves; one ejected for a failed check re-enters in place once its rerun passes (`queue.ejection-lifted`). Withdrawal dequeues; queueless `CLEAN`/`UNSTABLE`/`HAS_HOOKS` PRs merge at once, head-bound; `BLOCKED` auto-merge past ten minutes raises `merge-stalled` with GitHub's blocker.

### Bindings and carry

Reviews and proofs bind head, base and policy revision. On a moved base all carry if the patch-id held; else the approval carries if no reviewed file changed, as do proofs with disjoint `scopeFiles`. Republishing the same head and patch keeps them; a person's approval never carries.

The reviewer App re-posts a carried approval onto the tip; a newer approval re-binds it (`review.carry-refreshed`). With none usable, `mergerefused` clears it and requests a fresh review (`mergeRefusal.action: rereview`); a refusal standing 10 minutes raises attention and requests rework (`mergeRefusal.action: rework`, approver-judged in the high [risk lane](how-graphyard-works.md#risk-lanes)). Each fires once per recovery phase.

### Parallel tips

`mergeQueue.parallelTips` (default 4; `POST /api/merge-queue`) tips test at once, merging in order once all tips through theirs pass (`1` batches); a failing tip ejects its entry once those ahead pass, rebuilding later ones. Failing only `unit:docs-word-budget` ejects the entry whose change crossed the budget (the first at which the running total exceeds it), naming words over and pages that grew; a total the base carries is attributed to nobody, and an overage only warns ([development](development.md#documentation)).

### Optimistic merges

`mergeQueue.optimistic` (default on): a green entry disjoint from base changes lands unqueued unless it, or its base since its run, touched a `mergeQueue.optimisticExclude` (shared-infrastructure) glob; a main guard [reverts](master-agent.md#repair-lane) and reopens culprits (`master status`: `optimisticMerge`).

### Pre-merge gate and release-candidate validation

Required pre-merge: `typecheck` and `test` (`.github/workflows/ci.yml`): build, docs check, Node and browser suites, under ten minutes. Soak and timing-budget files (`releaseCandidateTests` in `scripts/ci-tests.mjs`), container acceptance and recovery and the Helm chart skip pull requests: `.github/workflows/release-candidate.yml` runs them on one pinned SHA (each [release candidate](delivery.md#release-candidates), or a dispatched `sha` or `rc-*` tag).

### Proofs in CI

A protected `pull_request_target` workflow per `graphyard/*` push: **plan** finds `unit:*`/`integration:*` proofs, **exercise** runs each secret-free on the base-merged candidate, **publish** reports via the [CI producer](deployment.md#ci-producer). Queue tips are cached. Manual proofs stay producer sessions.

`"deploySmoke": true` smoke-installs once production serves the merge; failure marks it [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Identity-bound agent review

`reviewProvider: "codex"` accepts only Codex's clean result on the exact head. `agent` needs a non-author reviewer App (`github-setup URL --reviewer claude`, in `GRAPHYARD_REVIEWER_APPS`) adopted by `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json); it approves by `graphyard-verdict` comment on the head.
