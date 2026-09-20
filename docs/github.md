<!-- page: Operate Graphyard | 3 | permissions, protection, CI, review. -->
# GitHub enforcement

For whoever wires GitHub to Graphyard: which identity holds which permission.

Graphyard uses a dedicated GitHub App, installation token minted from its private key and refreshed automatically, to observe the repository and publish **`Graphyard / merge`** on the exact pull-request head commit.

## Create and install the App

- **Personal account:** `graphyard github-setup HTTPS_URL` registers the App through a local manifest callback and saves its credentials ([onboarding](onboarding.md#2-connect-github)).
- **Organization account:** create by hand, installed only on the managed repository:
  - **Webhook:** `https://YOUR-HOST/api/github/webhook` and random secret
  - **Permissions:** [declared](#app-permissions)
  - **Events:** Pull request, Pull request review, Check run, Check suite, Issue comment, Push
  - **Variables:** generate a private key, set `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY` (full PEM, secret), `GITHUB_WEBHOOK_SECRET`, `GITHUB_REPOSITORY` and `GITHUB_BASE_BRANCH`, redeploy
- **A webhook ping proves nothing:** submit a test pull request, inspect the job and check.
- **A personal access token is no substitute:** the required check must be bound to a specific producer.

## App permissions

Every permission a Graphyard App identity holds is declared once, in `src/github-permissions.ts`, with the feature needing it; the manifest, tables below, preflight, job holds and `--update-permissions` migration all read it. Control plane first, reviewer App second.

| Permission | Access | Needed to |
| --- | --- | --- |
| Administration | Read | inspect branch protection (pull request observation) |
| Checks | Read and write | read CI check runs (pull request observation); publish `Graphyard / merge` on the exact candidate commit (the required check) |
| Contents | Read and write | read commits, trees and pull request files (pull request observation); publish speculative merge-queue tips: the merge commit on the candidate branch and the `refs/graphyard/queue/*` ref that binds it (the merge queue) |
| Issues | Read | receive `issue_comment` webhooks carrying review results (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | read pull requests and reviews (pull request observation); post review request comments (review dispatch) |

- **Reviewer App:** never granted Contents: write, Checks, or Administration, so it cannot write code, publish the required check or read protection
- **Workers:** worker identities are not Apps at all: ordinary GitHub accounts that push branches and open pull requests

| Permission | Access | Needed to |
| --- | --- | --- |
| Contents | Read | read the code under review (pull request observation) |
| Issues | Read | follow `issue_comment` events on the reviewed pull request (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | post the verdict comment (review dispatch) |

### Preflight and holds

- Server compares granted permissions with the declaration at startup, every five minutes and after any 403.
- **Shortfall:** under `appPermissions` in `/api/status`, on the dashboard, in `master status` under `controlPlane.attention`, naming missing permission, feature it blocks and installation page to accept the request on.
- **Jobs needing it:** **held, not retried**, re-checked every thirty minutes until a preflight sees it granted; one that cannot read the installation lifts nothing.
- **Unpredicted 401 or 403:** refusal, never a rate limit: at most three retries, then a thirty-minute hold released only when installation reading changes.
- **Held jobs:** `heldJobs`, `integration-held` in `diagnose`; no hold weakens a gate.

### Migrating an existing App

GitHub offers no API for changing a registered App's permissions; every installation must accept the change.

- **`github-setup --update-permissions [--wait 600] [--reviewer NAME]`:** on the machine holding `.graphyard/github-app.json`, reads both back, prints remaining steps, verifies acceptance, exits nonzero while anything remains
- **`--reviewer`:** reports a reviewer App's excess grants instead
- **The master does both halves itself:** `master browser app-permissions` raises the declared set, `master browser installation-accept` accepts the request, `master browser protection` reaches settings the API cannot

## The reviewer App

- Independent review uses a **second, separate App**: control-plane App observes and publishes the gate check, reviewer App reads code and posts reviews; binding the control-plane App as reviewer is refused.
- **Register:** `master reviewer setup [--name NAME] [--deployment HTTPS_ORIGIN] [--port PORT]` (default the master's URL and 4312), or by hand with Metadata read, Contents read, Pull requests write and Issues read.
- **Bind an existing App:** `master reviewer bind FILE --key-stdin`, refusing an installation that can write code, checks or administration.
- Each `master review GY-N` mints a repository-scoped token with `contents: read` and `pull_requests: write` for at most **one hour**, refuses one reporting longer life or broader permissions, removes it when the verdict closes the session.
- A review by `SLUG[bot]` on the exact head is an ordinary approval satisfying the native requirement and Graphyard's gate, both still requiring current head and an author other than the reviewer.

### Quota failover

- **Trigger:** `verdict:usage-limit` reply, or no verdict within the profile's `timeoutSeconds`
- **Record:** `review.failover` event — profile, runtime, reason, candidate, policy revision, comment ID, next profile
- **Effect:** releases the request, dispatches to the next untried profile; superseded one can no longer approve
- **Selection:** derived from that history, scoped to exact head, base and policy revision, so a rebase, new base or policy revision restarts at the first profile
- **Every profile exhausted:** review gate stays closed with `Every configured reviewer profile is exhausted for this candidate`: add capacity, wait for quota or select another provider
- **`master status`:** active profile, failover entries, `reviewFailover` count, attention when no reviewer capacity is left
- **`graphyard rereview GY-N`:** clears them, restarts at the first profile; ledger keeps every superseded entry

## Require the check

On the managed base branch:

- require status checks
- require **`Graphyard / merge`** bound to this App
- leave `strict` **off**: a queued candidate is deliberately behind the base; the [merge queue](#merge-queue) supersedes it
- enforce the rule for administrators
- disable force pushes and branch deletion
- remove bypass privileges from worker identities

Graphyard reads classic protection, refusing its merge gate unless these settings are present, conservatively on ruleset-only protection; `master protection --apply` and `master browser protection` then keep protection consistent with open review policies.

### What the merge gate checks

- **Pull request:** in the configured repository, targeting the configured base branch, head branch matching the workspace registered for the submission.
- Every configured CI check name passed from an approved CI App ID (`GITHUB_CI_APP_IDS`, default `15368` for GitHub Actions); pending, skipped, neutral, cancelled and failing checks do not; a right-named check from an unknown App cannot satisfy policy.
- Required independent review approves the current head; unresolved change requests refuse.
- Each acceptance proof has trusted evidence for the current head/base/policy tuple: pass result, nonzero executed count, zero skipped count.
- GitHub says the pull request is mergeable, not a draft; required protection is independently observed.
- Candidate is at the head of the merge queue, on the speculative tip it will land.

### The guarded merge

`master merge` is the only merge path.

- **Rechecked immediately before the GitHub call:** every gate and its evidence, head, base, draft state and mergeability, CI producer identity and current-head review, protection and the App-owned check including `strict` off, short-lived single-use merge execution
- **Base tip:** read from `refs/heads/<base>`, never cached `baseRefOid`
- **No administrative bypass:** Done follows only an independently observed matching merge
- **Protocol mismatch:** the CLI speaks a newer merge protocol than the deployed server, refusing with `server runs <sha>, CLI expects <sha>: deploy main first`
- **One executor per execution:** the executor instance that acquired an execution owns it — the loop is one instance per process, each `master merge` one named by its request id, so a replay under the same `GRAPHYARD_REQUEST_ID` resumes its own; the engine records the owner as `principal#instance` and refuses `merge-verify`, `merge-commit` and `merge-cancel` from any other, even under the same credential
- **Stand-down:** `master merge GY-N` beside a running loop is safe. An executor finding an execution another instance holds refuses before acquiring anything — `GY-N does not have a current all-gates-passing merge authorization for this executor: merge execution … is held by graphyard-master#daemon-… until …; this executor stands down without cancelling it` — as does a mid-flight `Merge execution was already verified` or `already committed` refusal. Never retry it against the holder or resolve it by hand: an unfinished execution lapses at expiry, reconciliation clears it, and the next cycle attempts afresh

## Merge queue

Graphyard serializes the final hop through one queue, so no merge invalidates candidates behind it.

- **Entry:** when a candidate passes its own gates; membership is derived, never requested
- **Nobody can** insert an entry, hold a position, reorder the queue or merge past the head
- **A merge moves the base** under every candidate still short of the queue, so the control plane republishes those heads on the moved tip itself and carries what the move did not touch
- **[Merge-queue bindings](protocol/merge-queue-binding.md):** what a candidate is bound to, when a [base refresh](protocol/merge-queue-binding.md#base-refresh) or the queue's own tip carries a review or proof, what a refresh conflict costs

## Trusted producers, smoke proof and review providers

- **A green job** proves a named check reported success, not that every behavioural criterion holds.
- **A dedicated producer** reads the report, verifies the code under test, sends evidence with its own credential, granted only the proof names it may produce ([proofs in CI](#proofs-in-ci), [CI-produced evidence](protocol/evidence.md#ci-produced-evidence)).
- **[Evidence](protocol/evidence.md#the-post-deployment-smoke-proof):** the post-deployment smoke proof
- **[Review providers](protocol/github-webhook.md):** `github`, `codex` and `agent`

### Proofs in CI

- Every `unit:*` and `integration:*` proof with a contract on `main` also runs as trusted CI, through one protected workflow on every push to a `graphyard/*` branch with an open pull request into the base branch.
- **Trigger:** `pull_request_target`, so GitHub takes workflow file and harness checkout from the default branch; the candidate is only fetched into an isolated build context.
- **A queue tip or [base refresh](protocol/merge-queue-binding.md#base-refresh)** is committed onto the pull-request branch, so the same `synchronize` trigger runs it on the tip that will land.
- **Jobs:** plan enumerates the item's proofs, exercise jobs run one per proof in parallel holding no secret, publish submits each report through the [CI producer](deployment.md#ci-producer), re-verified against the GitHub job ([CI-produced evidence](protocol/evidence.md#ci-produced-evidence)).
- Dependencies, database image and candidate layers are cached, so a warm proof job finishes in minutes.
- Manual proofs stay producer sessions started at submit, the deploy smoke proof after delivery.

## Enforcement boundary

No transaction spans both systems: ledger changes immediately while check publication goes through a separate API, so a delay can separate a refusal from revocation of a previously successful check; GitHub never expires a check when Graphyard goes offline ([the merge execution boundary](architecture.md#the-merge-execution-boundary)).

- **Rate limit:** 429, or 403 carrying `x-ratelimit-remaining: 0`, `Retry-After` header or rate-limit message, pauses that process's client for at least a minute
- **Permission refusal:** 401, or 403 without those signals, never pauses it

## Troubleshooting

- **Disconnected, or a job shows 401:** App ID, installation ID, PEM secret, server restart; a rejected key is a refusal, not a pause
- **403 or held job:** `appPermissions` in `/api/status`; `master browser installation-accept`, or `github-setup --update-permissions`
- **Protection gate refuses:** Check name, App binding, `strict` left enabled, admin enforcement, force and delete settings
- **Acceptance refuses despite green CI:** Proof names, producer grant, candidate SHA, base SHA, policy revision, skipped count
- **PR changed while observed, or no webhook update:** Ordinary concurrency retry; signature secret and job errors, polling as fallback
