<!-- page: Operate Graphyard | 3 | App permissions, branch protection, CI producers, and Codex review. -->
# GitHub enforcement

Graphyard uses a dedicated GitHub App that observes the repository and publishes
**`Graphyard / merge`** on the exact PR head commit. A personal access token is no substitute.

## Create and install the App

`graphyard github-setup HTTPS_URL` registers it through a local manifest flow (the installer
does this). Manually: webhook `https://YOUR-HOST/api/github/webhook` with a random secret,
exactly the [declared permissions](#app-permissions), events Pull request, Pull request review,
Check run, Check suite, Issue comment and Push, installed only on the managed repository. Set
`GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`,
`GITHUB_REPOSITORY` and `GITHUB_BASE_BRANCH`, redeploy, and prove it with a test PR.

## App permissions

Every permission is declared once in `src/github-permissions.ts`; the manifest, these tables,
the preflight and the migration all read it. The control-plane App holds:

| Permission | Access | Needed to |
| --- | --- | --- |
| Administration | Read | inspect branch protection (pull request observation) |
| Checks | Read and write | read CI check runs (pull request observation); publish `Graphyard / merge` on the exact candidate commit (the required check) |
| Contents | Read and write | read commits, trees and pull request files (pull request observation); publish speculative merge-queue tips: the merge commit on the candidate branch and the `refs/graphyard/queue/*` ref that binds it (the merge queue) |
| Issues | Read | receive `issue_comment` webhooks carrying review results (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | read pull requests and reviews (pull request observation); post review request comments (review dispatch) |

Contents: write exists only for the [merge queue](#merge-queue)'s merge commits of validated
candidates. A reviewer App is never granted Contents: write, Checks, or Administration, and
worker identities are not Apps at all. A reviewer App holds:

| Permission | Access | Needed to |
| --- | --- | --- |
| Contents | Read | read the code under review (pull request observation) |
| Issues | Read | follow `issue_comment` events on the reviewed pull request (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | post the verdict comment (review dispatch) |

### Preflight and holds

At startup, every five minutes and after any 403 the server compares granted permissions with
the declaration. A shortfall appears under `appPermissions` in `GET /api/status`, the dashboard
and `master status`, and jobs needing it are **held, not retried** (`heldJobs`; `diagnose GY-N`
shows `integration-held`). An unexplained 401/403 retries three times, then holds for thirty
minutes. Holds never weaken a gate.

### Migrating an existing App

```sh
node "$GRAPHYARD_CLI" github-setup --update-permissions --wait 600
```

It prints the remaining steps (set the permission at
`https://github.com/settings/apps/APP-SLUG/permissions`, accept the request at
`https://github.com/settings/installations/ID`) and exits nonzero until done; the next preflight
releases held jobs. The master does these itself with `graphyard master browser app-permissions`
and `graphyard master browser installation-accept`
([browser administration](master-agent-reference.md#github-administration-through-the-browser)).
`--reviewer NAME` checks a reviewer App for excess grants.

## The reviewer App

Independent review uses a second reviewer App, separate from the control-plane App, which can
never review what it gates. Create it with `graphyard master reviewer setup` (Metadata read,
Contents read, Pull requests write, Issues read), then
`graphyard master reviewer bind FILE --key-stdin`; binding refuses an installation that can write
code, checks or administration. Each `graphyard master review GY-N` mints a token limited to
`contents: read` and `pull_requests: write`, valid for at most one hour, handed over through a
private `GH_CONFIG_DIR`. An approval by `SLUG[bot]` on the exact head satisfies both GitHub and
Graphyard.

## Require the check

On the base branch: require status checks, require `Graphyard / merge` bound to this App, leave
"require up to date" (`strict`) **off**, enforce for administrators, disable force pushes and
deletion, and remove bypass rights from worker identities. Only classic protection is read;
ruleset-only protection refuses. `graphyard master protection --apply` reconciles the review
settings; `graphyard master browser protection` does it on the settings page when the API cannot.

## What is checked

- PR is in the repository, targets the base branch, and its head branch matches the registered workspace.
- Every configured CI check passed from an App in `GITHUB_CI_APP_IDS` (default `15368`).
- Independent review approves the current head; no outstanding change requests.
- Each proof has trusted passing evidence for the current head/base/policy, executed > 0, skipped 0.
- GitHub reports the PR mergeable and not a draft; protection is observed.
- The candidate heads the merge queue, on the tip it will land.

## Merge queue

A candidate enters when its own gates pass; nobody can insert, reorder or bypass entries. The
head predicts against the base branch, each later entry against the validated tip ahead of it.
Graphyard merges the predicted base into the candidate branch, so the speculative tip is pushed
onto the candidate branch, published under `refs/graphyard/queue/KEY`, and every check, review
and proof must bind that exact commit. Base-tree-identical advances (an earlier queue merge) keep
bindings (`queue.base-carried`); any other base change re-validates.

Ejection reasons: a failed required check, requested changes, a failed or revoked proof, a merge
conflict, a policy revision, or rework. Pending validation never ejects; a repaired candidate
re-enters at the back. `master status` and `diagnose GY-N` show position, predicted base and
bindings ([master-agent](master-agent.md#merge-queue)).

### Base refresh for in-flight candidates

When the base moves under an unqueued candidate, the candidate stays bound to its base while the
branch still contains it, and the reconciliation job merges the base into the PR branch. The
approval carries when the base changed no reviewed file; each proof carries when its `scopeFiles`
are disjoint from the change; CI always re-runs. A conflict writes nothing and returns the item
to `build` for the worker.

### Binding carry across a Graphyard-authored tip

For a tip `H'` Graphyard produced from head `H`: it must be a two-parent, conflict-free merge of
`H` and the predicted base, authored by the control-plane App. Then the approval carries if the
predecessor changed none of `H`'s files, and each proof carries if its `scopeFiles` are disjoint.
Anything else re-requires every binding. Before merging, the master re-posts a carried approval
through the same reviewer App. Decisions are recorded as `queue.carry` events.

## Inspect enforcement

```sh
node scripts/verify-enforcement.mjs GY-N [PR_NUMBER]
```

A read-only report joining GitHub and Graphyard state; the verdict is `refused` or `permitted`.
It is not evidence and authorizes nothing.

## Trusted test producers

A dedicated producer reads the real test report and submits evidence with its own credential,
granted only its proof names. The protected acceptance publisher binds the workflow run,
attempt, candidate head/base, counts and artifact digest; ambiguity refuses.

### Proofs in CI

The protected workflow runs on every push to a `graphyard/*` PR branch via `pull_request_target`,
so the workflow and secrets come from the default branch:

1. **plan** (`graphyard-reporting` environment) finds the item and plans its registered `unit:*`
   and `integration:*` proofs for the candidate's head, base and policy revision.
2. **exercise** runs one secret-free job per proof against the candidate merged with its base.
3. **publish** submits each report through the CI producer with a `ciRun` binding the plane verifies.

A queue tip is committed onto the pull-request branch, so the tip gets the same run. `~/.npm`,
the Postgres image and candidate image layers are cached. Manual proofs stay producer sessions
and the deploy smoke proof runs after delivery. Keep `graphyard-reporting` restricted to the
default branch; never expose the producer secret to PR code.

## Post-deployment smoke proof

```json
{ "policy": { "checks": ["test", "typecheck"], "review": true, "deploySmoke": true } }
```

`deploySmoke` is policy, not a criterion. When the release serves the merge, the master records
the deployment (`POST /api/work/UUID/deployment`) and dispatches the smoke workflow
(`master init --smoke-workflow deploy-smoke.yml`). `scripts/deploy-smoke.mjs` checks the serving
commit, runs the checks, and publishes `e2e:deploy-smoke` through a producer granted only that
proof (`graphyard grants grant smoke e2e:deploy-smoke "Post-deployment smoke reporter"`). A failure
marks the item **delivered with failure**
([recovery](operations-reference.md#delivered-with-a-failed-smoke-proof)).

## Enforcement boundary

No transaction spans GitHub and Postgres. The master narrows the gap with a short-lived merge
execution, a final re-observation and an exact-head merge call; [revocation](protocol/evidence.md#revocation)
cancels an execution until its commit point. Delivery counts only for a merge following that
authority; other merges are permanent violations. Check runs are commit-scoped, so restrict other
merge identities in repository rules. A worker can still push its own branch after losing its
lease; worktrees and supervision reduce, not prevent, that.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| GitHub disconnected / 401 | App ID, installation ID, private key |
| 403 or held job | `appPermissions`; `master browser installation-accept` or `github-setup --update-permissions` |
| Protection gate refuses | check name, App binding, `strict` off, admin enforcement (`master browser protection`) |
| Acceptance refuses despite green CI | proof names, grants, candidate SHA, base, policy revision, skipped count |
| No update after webhook | webhook secret and job errors; polling still runs |

## Agent review approval (Codex cloud adapter)

`reviewProvider: "codex"` dispatches a marked `@codex review` comment bound to head, base and
policy revision, and accepts only the connector's recognised clean result on that exact head;
unknown formats refuse. Adopt it with
`graphyard reviewpolicy GY-N codex CURRENT_POLICY_REVISION "reason"`; request again with
`graphyard rereview GY-N`. Before dropping the native approval count, run
`node scripts/protect-github.mjs --plan --agent-reviews` (then `--apply`).

## Identity-bound agent review providers

The `agent` provider requires an approval from a registered reviewer App distinct from the
author, bound to the exact head. Register one per reviewer:

```sh
graphyard github-setup https://your-graphyard-deployment.example --reviewer claude
```

Add it to `GRAPHYARD_REVIEWER_APPS`:

```json
[{ "id": "claude-reviewer", "runtime": "claude", "appId": 1550001, "botUserId": 1550002 }]
```

Select ordered profiles ([examples/reviewer-profiles.json](../examples/reviewer-profiles.json)):

```sh
graphyard reviewpolicy GY-N agent CURRENT_POLICY_REVISION "Adopt identity-bound agent review" --profiles examples/reviewer-profiles.json
```

The reviewer replies, as its App, with one line:

```
<!-- graphyard-verdict:MARKER head:FULL_40_CHAR_SHA verdict:approved -->
```

`verdict:changes-requested` reports findings; `verdict:usage-limit` or silence past
`timeoutSeconds` fails over to the next profile. When every profile is exhausted the gate stays
closed; `graphyard rereview GY-N` restarts at the first profile.
