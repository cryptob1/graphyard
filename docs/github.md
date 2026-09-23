<!-- page: Operate Graphyard | 3 | permissions, protection. -->
# GitHub enforcement

For whoever wires GitHub to Graphyard: which identity holds which permission.

A dedicated GitHub App, its installation token minted from its private key and refreshed automatically, observes the repository and publishes **`Graphyard / merge`** on the exact pull-request head commit.

## Create and install the App

- **Personal account:** `graphyard github-setup HTTPS_URL` registers the App through a local manifest callback and saves its credentials ([onboarding](onboarding.md#2-connect-github)).
- **Organization account:** create by hand, installed only on the managed repository:
  - **Webhook:** `https://YOUR-HOST/api/github/webhook` and random secret
  - **Permissions:** [declared](#app-permissions)
  - **Events:** Pull request, Pull request review, Check run, Check suite, Issue comment, Push
  - **Variables:** generate a private key, set `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY` (full PEM, secret), `GITHUB_WEBHOOK_SECRET`, `GITHUB_REPOSITORY` and `GITHUB_BASE_BRANCH`, redeploy

## App permissions

Every permission is declared once in `src/github-permissions.ts` with the feature needing it; manifest, tables below, preflight, job holds and the `--update-permissions` migration read it. Control plane first, reviewer App second.

| Permission | Access | Needed to |
| --- | --- | --- |
| Administration | Read | inspect branch protection (pull request observation) |
| Checks | Read and write | read CI check runs (pull request observation); publish `Graphyard / merge` on the exact candidate commit (the required check) |
| Contents | Read and write | read commits, trees and pull request files (pull request observation); publish speculative merge-queue tips: the merge commit on the candidate branch and the `refs/graphyard/queue/*` ref that binds it (the merge queue) |
| Issues | Read | receive `issue_comment` webhooks carrying review results (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | read pull requests and reviews (pull request observation); post review request comments (review dispatch) |

- **Reviewer App:** never granted Contents: write, Checks, or Administration

| Permission | Access | Needed to |
| --- | --- | --- |
| Contents | Read | read the code under review (pull request observation) |
| Issues | Read | follow `issue_comment` events on the reviewed pull request (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | post the verdict comment (review dispatch) |

### Preflight and holds

- **Compared** with the declaration at startup, every five minutes and after any 403.
- **Shortfall:** in the server log, under `appPermissions` in `/api/status`, on the dashboard and in `master status` under `controlPlane.attention`, naming the missing permission, the feature it blocks and the installation page to accept it on.
- **Held jobs:** `heldJobs`, `integration-held` in `diagnose`; no hold weakens a gate.

### Migrating an existing App

GitHub offers no API for changing a registered App's permissions: every installation must accept it.

- **`github-setup --update-permissions [--wait 600] [--reviewer NAME]`:** on the machine holding `.graphyard/github-app.json`; reads both back, prints remaining steps, verifies acceptance, exits nonzero while anything remains, and with `--reviewer` reports a reviewer App's excess grants instead

## The reviewer App

- **Register:** `master reviewer setup [--name NAME] [--deployment HTTPS_ORIGIN] [--port PORT]` (default the master's URL and 4312), or by hand with Metadata read, Contents read, Pull requests write and Issues read; `master reviewer bind FILE --key-stdin` binds an App you already have, refusing an installation that can write code, checks or administration.
- **Token:** each `master review GY-N` mints a repository-scoped one with `contents: read` and `pull_requests: write` for at most **one hour**, refuses one reporting longer life or broader permissions, and removes it when the verdict closes the session.

### Quota failover

- **Trigger:** `verdict:usage-limit` reply, or no verdict within the profile's `timeoutSeconds`
- **Record:** `review.failover` event: profile, runtime, reason, candidate, policy revision, comment ID, next profile
- **Effect:** releases the request, dispatches to the next untried profile; superseded one can no longer approve
- **`master status`:** active profile, failover entries, `reviewFailover` count, attention when no reviewer capacity is left
- **`graphyard rereview GY-N`:** clears them, restarts at the first profile; ledger keeps every superseded entry

### Dismissed approvals and unanswered requests

- **A dismissed approval is not an answer:** `dismiss_stale_reviews`, a recomputed merge base or a manual dismissal withdraws one, the gate goes on refusing, and the session is recorded `failed` and unanswered with the cause, relaunched on the usual wait. Dismissed *with the head moved* cancels that request and reviews the new head afresh; dismissed *on an unchanged candidate* reviews the same commit again, with no new head and no rework round. A relaunch skips that head's earlier verdicts; a dismissal after a session closed reopens its record while the request stands
- **Unanswered requests are attention, not silence:** only an `APPROVED` or `CHANGES_REQUESTED` verdict answers a request, and nothing follows a settled session, so `master status` names each settled-but-unanswered request in `attentionItems` with the verdict, how long it has stood and the command that answers it, counts them in `counts.dispatchUnanswered` apart from `counts.dispatchRunning`, and `master run` reports it `waiting`. `master review GY-N [PROFILE]` forces the next attempt against the exact head's open request (its `requestId`); a head with no open request records none, and a producer request in that state is recovered with `master decide GY-N rework REASON`

## Require the check

On the managed base branch:

- require status checks
- require **`Graphyard / merge`** bound to this App
- leave `strict` **off**: a queued candidate is deliberately behind the base; the [merge queue](#merge-queue) supersedes it
- enforce the rule for administrators
- disable force pushes and branch deletion
- remove bypass privileges from worker identities

Graphyard reads classic protection, refusing its merge gate unless these settings are present and conservatively on ruleset-only protection; `master protection --apply` and `master browser protection` keep it consistent with open review policies.

### What the merge gate checks

- **Pull request:** in the configured repository, targeting the configured base branch, head branch matching the workspace registered for the submission.
- Required independent review approves the current head; unresolved change requests refuse.
- Each acceptance proof has trusted evidence for the current head/base/policy tuple: pass result, nonzero executed count, zero skipped count.
- GitHub says the pull request is mergeable, not a draft; required protection is independently observed.
- Candidate is at the head of the merge queue, on the speculative tip it will land.

### The guarded merge

`master merge` is the only merge path.

- **Rechecked immediately before the GitHub call:** every gate and its evidence, head, base, draft state and mergeability, CI producer identity and current-head review, protection and the App-owned check including `strict` off, short-lived single-use merge execution
- **Base tip:** read from `refs/heads/<base>`, never cached `baseRefOid`
- **No administrative bypass:** Done follows only an independently observed matching merge
- **One executor per execution:** the instance that acquired it owns it — the loop one instance per process, each `master merge` one named by its request id, so a replay under the same `GRAPHYARD_REQUEST_ID` resumes its own; the engine records the owner as `principal#instance` and refuses `merge-verify`, `merge-commit` and `merge-cancel` from any other, even under the same credential
- **Stand-down:** `master merge GY-N` beside a running loop is safe. An executor finding an execution another instance holds refuses before acquiring anything (`merge execution … is held by graphyard-master#daemon-… until …; this executor stands down without cancelling it`), as does a mid-flight `Merge execution was already verified` or `already committed`. Never retry against the holder or resolve it by hand: an unfinished execution lapses at expiry, reconciliation clears it, and the next cycle attempts afresh

## Merge queue

Graphyard serializes the final hop through one queue, so no merge invalidates candidates behind it.

- **[Merge-queue bindings](protocol/merge-queue-binding.md):** what a candidate is bound to, when a [base refresh](protocol/merge-queue-binding.md#base-refresh) or the queue's tip carries a review or proof, what a refresh conflict costs

## Trusted producers, smoke proof and review providers

- **A green job** proves a named check reported success, not that every behavioural criterion holds; a dedicated producer reads the report, verifies the code under test and sends evidence with its own credential, granted only the proof names it may produce ([proofs in CI](#proofs-in-ci), [CI-produced evidence](protocol/evidence.md#ci-produced-evidence)).
- **[Evidence](protocol/evidence.md#the-post-deployment-smoke-proof):** the post-deployment smoke proof. **[Review providers](protocol/github-webhook.md):** `github`, `codex` and `agent`

### Proofs in CI

- Every `unit:*` and `integration:*` proof with a contract on `main` also runs as trusted CI, through one protected workflow on every push to a `graphyard/*` branch with an open pull request into the base branch.
- **Trigger:** `pull_request_target`, so GitHub takes the workflow file and harness checkout from the default branch and the candidate is only fetched into an isolated build context. A queue tip or [base refresh](protocol/merge-queue-binding.md#base-refresh) is committed onto the pull-request branch, so the same `synchronize` trigger runs it on the tip that will land.
- Manual proofs stay producer sessions started at submit, the deploy smoke proof after delivery.

## Enforcement boundary

No transaction spans both systems: the ledger changes immediately and check publication goes through a separate API, so a refusal can precede revocation of a previously successful check, and GitHub never expires a check when Graphyard goes offline ([the merge execution boundary](architecture.md#the-merge-execution-boundary)).

- **Permission refusal:** 401, or 403 without those signals, never pauses it
