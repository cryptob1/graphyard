<!-- page: Operate Graphyard | 3 | permissions, protection, CI, review. -->
# GitHub enforcement

For whoever wires GitHub to Graphyard: which identity holds which permission.

Graphyard uses a dedicated GitHub App whose installation token is minted from its private key and refreshed automatically; it observes the repository and publishes **`Graphyard / merge`** on the exact pull-request head commit.

## Create and install the App

`graphyard github-setup HTTPS_URL` registers a personal-account App through a local manifest callback and saves its credentials ([onboarding](onboarding.md#2-connect-github)). For an organization account, create it by hand with the webhook at `https://YOUR-HOST/api/github/webhook` and a random secret, the [declared permissions](#app-permissions), the Pull request, Pull request review, Check run, Check suite, Issue comment and Push events, installed only on the managed repository; then generate a private key, set `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY` (full PEM, secret), `GITHUB_WEBHOOK_SECRET`, `GITHUB_REPOSITORY` and `GITHUB_BASE_BRANCH`, and redeploy. A webhook ping proves nothing: submit a test pull request and inspect the job and the check. A personal access token is not a substitute, because the required check must be bound to a specific producer.

## App permissions

Every permission a Graphyard App identity holds is declared once, in `src/github-permissions.ts`, with the feature needing it; the manifest, the tables below, the preflight, the job holds and the `--update-permissions` migration all read it. Control plane first, reviewer App second.

| Permission | Access | Needed to |
| --- | --- | --- |
| Administration | Read | inspect branch protection (pull request observation) |
| Checks | Read and write | read CI check runs (pull request observation); publish `Graphyard / merge` on the exact candidate commit (the required check) |
| Contents | Read and write | read commits, trees and pull request files (pull request observation); publish speculative merge-queue tips: the merge commit on the candidate branch and the `refs/graphyard/queue/*` ref that binds it (the merge queue) |
| Issues | Read | receive `issue_comment` webhooks carrying review results (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | read pull requests and reviews (pull request observation); post review request comments (review dispatch) |

The reviewer App is never granted Contents: write, Checks, or Administration, so it cannot write code, publish the required check or read protection, and worker identities are not Apps at all: ordinary GitHub accounts that push branches and open pull requests.

| Permission | Access | Needed to |
| --- | --- | --- |
| Contents | Read | read the code under review (pull request observation) |
| Issues | Read | follow `issue_comment` events on the reviewed pull request (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | post the verdict comment (review dispatch) |

### Preflight and holds

The server compares granted permissions with the declaration at startup, every five minutes and after any 403. A shortfall appears under `appPermissions` in `/api/status`, on the dashboard and in `master status` under `controlPlane.attention`, naming the missing permission, the feature it blocks and the installation page to accept the request on. Jobs needing it are **held, not retried**, re-checked every thirty minutes until a preflight sees it granted, and a preflight that cannot read the installation lifts nothing. An unpredicted 401 or 403 is a refusal, never a rate limit: at most three retries, then a thirty-minute hold released only when the installation reading changes. Held jobs appear as `heldJobs` and in `diagnose` as `integration-held`; no hold weakens a gate.

### Migrating an existing App

GitHub offers no API for changing a registered App's permissions, and every installation must accept the change. On the machine holding `.graphyard/github-app.json`, `github-setup --update-permissions [--wait 600] [--reviewer NAME]` reads both back, prints the remaining steps, verifies acceptance and exits nonzero while anything remains; `--reviewer` reports a reviewer App's excess grants instead. The master does both halves itself: `master browser app-permissions` raises the declared set, `master browser installation-accept` accepts the request, `master browser protection` reaches settings the API cannot.

## The reviewer App

Independent review uses a **second, separate App**: the control-plane App observes and publishes the gate check, the reviewer App reads code and posts reviews, and binding the control-plane App as reviewer is refused. Register it with `master reviewer setup [--name NAME]`, or by hand with Metadata read, Contents read, Pull requests write and Issues read; `master reviewer bind FILE --key-stdin` binds an existing App, refusing an installation that can write code, checks or administration. Each `master review GY-N` mints a repository-scoped token with `contents: read` and `pull_requests: write` for at most **one hour**, refuses one reporting a longer life or broader permissions, and removes it when the verdict closes the session. A review by `SLUG[bot]` on the exact head is an ordinary approval satisfying the native requirement and Graphyard's gate, both still requiring the current head and an author other than the reviewer.

### Quota failover

Provider exhaustion is a capacity fact, not an approval. A `verdict:usage-limit` reply, or no verdict within the profile's `timeoutSeconds`, records a `review.failover` event — profile, runtime, reason, candidate, policy revision, request comment ID, next profile — releases the request and dispatches to the next untried profile, after which the superseded one can no longer approve. Selection is derived from that history, scoped to the exact head, base and policy revision, so a rebase, new base or policy revision restarts at the first profile. With every profile exhausted the review gate stays closed with `Every configured reviewer profile is exhausted for this candidate`: add capacity, wait for quota or select another provider. `master status` reports the active profile, the failover entries, a `reviewFailover` count and attention when no reviewer capacity is left; `graphyard rereview GY-N` clears them and restarts at the first profile, while the ledger keeps every superseded entry and the work document the last hundred.

## Require the check

On the managed base branch: require status checks; require **`Graphyard / merge`** bound to this App; leave `strict` **off**, since a queued candidate is deliberately behind the base and the [merge queue](#merge-queue) supersedes it; enforce the rule for administrators; disable force pushes and branch deletion; remove bypass privileges from worker identities. Graphyard reads classic protection, refuses its merge gate unless these settings are present, and refuses conservatively on ruleset-only protection; `master protection --apply` and `master browser protection` then keep protection consistent with the open review policies.

### What the merge gate checks

- The pull request is in the configured repository, targets the configured base branch, and its head branch matches the workspace registered for the submission.
- Every configured CI check name passed from an approved CI App ID (`GITHUB_CI_APP_IDS`, default `15368` for GitHub Actions); pending, skipped, neutral, cancelled and failing checks do not, and a check with the right name from an unknown App cannot satisfy policy.
- Required independent review approves the current head; unresolved change requests refuse.
- Each acceptance proof has trusted evidence for the current head/base/policy tuple, with a pass result, nonzero executed count and zero skipped count.
- GitHub says the pull request is mergeable and not a draft, and required protection is independently observed.
- The candidate is at the head of the merge queue, on the speculative tip it will land.

### The guarded merge

`master merge` is the only merge path. Immediately before the GitHub call it rechecks every gate and its evidence, head, base, draft state and mergeability, CI producer identity and current-head review, protection and the App-owned check including `strict` off, and a short-lived single-use merge execution; the base tip is read from `refs/heads/<base>`, never the cached `baseRefOid`. There is no administrative bypass, Done follows only an independently observed matching merge, and a protocol mismatch refuses with `server runs <sha>, CLI expects <sha>: deploy main first`.

## Merge queue

Graphyard serializes the final hop through one queue, so that no merge invalidates the candidates behind it. A candidate enters when it passes its own gates, and membership is derived, never requested: nobody can insert an entry, hold a position, reorder the queue or merge past the head. A merge moves the base under every candidate still short of the queue, so the control plane republishes those heads on the moved tip itself and carries what the move did not touch. What a candidate is bound to, when a [base refresh](protocol/merge-queue-binding.md#base-refresh) or the queue's own tip carries a review or proof, and what a refresh conflict costs are in [merge-queue bindings](protocol/merge-queue-binding.md).

## Trusted producers, smoke proof and review providers

A green job proves that a named check reported success, not that every behavioural criterion holds. A dedicated producer reads the report, verifies the code under test and sends evidence with its own credential, granted only the proof names it may produce ([proofs in CI](first-pr.md#proofs-in-ci), [CI-produced evidence](protocol/evidence.md#ci-produced-evidence)); the post-deployment smoke proof and the `github`, `codex` and `agent` review providers are in [evidence](protocol/evidence.md#the-post-deployment-smoke-proof) and [review providers](protocol/github-webhook.md).

## Enforcement boundary

No transaction spans both systems: the ledger changes immediately while check publication goes through a separate API, so a refusal and the revocation of a previously successful check can be separated by a delay, and GitHub never expires a check when Graphyard goes offline ([the merge execution boundary](architecture.md#the-merge-execution-boundary)). A 429, or a 403 carrying `x-ratelimit-remaining: 0`, a `Retry-After` header or a rate-limit message, pauses that process's client for at least a minute; a 401, or a 403 without those signals, is a permission refusal and never pauses it.

## Troubleshooting

- **Disconnected, or a job shows 401:** App ID, installation ID, PEM secret, server restart; a rejected key is a refusal, not a pause
- **403 or held job:** `appPermissions` in `/api/status`; `master browser installation-accept`, or `github-setup --update-permissions`
- **Protection gate refuses:** Check name, App binding, `strict` left enabled, admin enforcement, force and delete settings
- **Acceptance refuses despite green CI:** Proof names, producer grant, candidate SHA, base SHA, policy revision, skipped count
- **PR changed while observed, or no update after a webhook:** Ordinary concurrency retry; signature secret and job errors, polling as the fallback
