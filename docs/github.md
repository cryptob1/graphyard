<!-- page: Operate Graphyard | 3 | App permissions, protection, CI producers, review. -->
# GitHub enforcement

For whoever wires GitHub to Graphyard: which identity holds which permission.

Graphyard uses a dedicated GitHub App whose installation token is minted from the App private key and refreshed automatically. The App observes the repository and publishes **`Graphyard / merge`** on the exact pull-request head commit.

## Create and install the App

`graphyard github-setup HTTPS_URL` registers a personal-account App through a local manifest callback and saves its credentials ([onboarding](onboarding.md#2-connect-github)). For an organization account, create it by hand with the webhook at `https://YOUR-HOST/api/github/webhook` and a random secret, the [declared permissions](#app-permissions), the Pull request, Pull request review, Check run, Check suite, Issue comment and Push events, installed only on the managed repository. Generate a private key, set `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY` (full PEM, secret), `GITHUB_WEBHOOK_SECRET`, `GITHUB_REPOSITORY` and `GITHUB_BASE_BRANCH`, and redeploy; the installation ID is in the installation settings URL, the App ID in the App's settings. A webhook ping does not prove the integration works — submit a test pull request and inspect the job and the check. A personal access token is deliberately not a substitute: the required check must be bound to a specific producer.

## App permissions

Every permission a Graphyard App identity holds is declared once, in `src/github-permissions.ts`, with the feature that needs it; the manifest, the tables below, the preflight, the job holds and the `--update-permissions` migration all read that declaration. The control plane's set is first, the reviewer App's second.

| Permission | Access | Needed to |
| --- | --- | --- |
| Administration | Read | inspect branch protection (pull request observation) |
| Checks | Read and write | read CI check runs (pull request observation); publish `Graphyard / merge` on the exact candidate commit (the required check) |
| Contents | Read and write | read commits, trees and pull request files (pull request observation); publish speculative merge-queue tips: the merge commit on the candidate branch and the `refs/graphyard/queue/*` ref that binds it (the merge queue) |
| Issues | Read | receive `issue_comment` webhooks carrying review results (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | read pull requests and reviews (pull request observation); post review request comments (review dispatch) |

The reviewer App is deliberately weaker — it is never granted Contents: write, Checks, or Administration, so it cannot write code, publish the required check or read protection — and worker identities are not Apps at all: they are ordinary GitHub accounts that push branches and open pull requests.

| Permission | Access | Needed to |
| --- | --- | --- |
| Contents | Read | read the code under review (pull request observation) |
| Issues | Read | follow `issue_comment` events on the reviewed pull request (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | post the verdict comment (review dispatch) |

### Preflight and holds

The server compares granted permissions with the declaration at startup, every five minutes and after any 403. A shortfall appears under `appPermissions` in `/api/status`, on the dashboard and in `master status` under `controlPlane.attention`, naming the missing permission, the feature it blocks and the installation page to accept the pending request on. Jobs needing it are **held, not retried**, until a preflight sees it granted; a held job re-checks every thirty minutes, and a preflight that cannot read the installation lifts nothing. An unpredicted 401 or 403 is a refusal, never a rate limit: at most three retries, then a thirty-minute hold released only when the installation reading changes. Held jobs appear as `heldJobs` and in `diagnose` as `integration-held`, and no hold weakens a gate.

### Migrating an existing App

GitHub offers no API for changing a registered App's permissions, and every installation must accept a change explicitly. On the machine holding `.graphyard/github-app.json`, `github-setup --update-permissions [--wait 600] [--reviewer NAME]` reads both back, prints the remaining steps, verifies acceptance and exits nonzero while anything remains; `--reviewer` reports a reviewer App's excess grants instead. The master does both halves without a human: `master browser app-permissions` raises the declared set, `master browser installation-accept` accepts the request it raises, and `master browser protection` reaches protection settings the API cannot.

## The reviewer App

Independent review uses a **second, separate App**: the control-plane App observes and publishes the gate check, the reviewer App reads code and posts reviews, and binding the control-plane App as reviewer is refused. Register it with `master reviewer setup [--name NAME]`, or by hand with Metadata read, Contents read, Pull requests write and Issues read; `master reviewer bind FILE --key-stdin` binds an existing App and refuses an installation that can write code, checks or administration. Each `master review GY-N` mints a repository-scoped token with `contents: read` and `pull_requests: write` for at most **one hour**, refuses one reporting a longer life or broader permissions, and removes it when the verdict closes the session. A review by `SLUG[bot]` on the exact head is an ordinary approval satisfying both the native requirement and Graphyard's gate, each still requiring the current head and an author other than the reviewer.

### Quota failover

Provider exhaustion is a capacity fact, not an approval. A `verdict:usage-limit` reply, or no verdict within the profile's `timeoutSeconds`, records a `review.failover` event — profile, runtime, exhaustion reason, candidate, policy revision, request comment ID and the next profile — releases the request and dispatches to the next untried profile on the same candidate; the superseded profile can no longer approve it. Selection is derived from that history rather than stored, so it is scoped to the exact head, base and policy revision, and a rebase, new base or policy revision restarts at the first profile. When every profile is exhausted the review gate stays closed with `Every configured reviewer profile is exhausted for this candidate`: add capacity, wait for quota or select another provider — Graphyard never approves work because reviewers ran out. `master status` reports the active profile, the candidate's failover entries, a `reviewFailover` count and attention when a task has no reviewer capacity left; `graphyard rereview GY-N` clears those entries and restarts at the first profile, while the ledger keeps every superseded entry and the work document the last hundred.

## Require the check

On the managed base branch: require status checks; require **`Graphyard / merge`** bound to this App; leave `strict` **off**, because a queued candidate is deliberately behind the base and the [merge queue](#merge-queue) supersedes it; enforce the rule for administrators; disable force pushes and branch deletion; remove bypass privileges from worker identities. GitHub may require the App to publish a check before it can be selected, so submit a linked pull request first. Graphyard reads classic protection and refuses its merge gate unless these settings are present; ruleset-only protection refuses conservatively. Afterwards `master protection --apply` and `master browser protection` keep protection consistent with the open review policies.

### What the merge gate checks

- The pull request is in the configured repository, targets the configured base branch, and its head branch matches the workspace registered for the submission.
- Every configured CI check name passed from an approved CI App ID; pending, skipped, neutral, cancelled and failing checks do not. `GITHUB_CI_APP_IDS` defaults to `15368` (GitHub Actions), and a check with the right name from an unknown App cannot satisfy policy.
- Required independent review approves the current head; unresolved change requests refuse.
- Each acceptance proof has trusted evidence for the current head/base/policy tuple, with a pass result, nonzero executed count and zero skipped count.
- GitHub says the pull request is mergeable and not a draft, and required protection is independently observed.
- The candidate is at the head of the merge queue, on the speculative tip it will land.

### The guarded merge

`master merge` is the only merge path. Immediately before the GitHub call Graphyard rechecks every gate and its evidence, head, base, draft state and mergeability, CI producer identity and current-head review, protection and the App-owned check including `strict` off, and a short-lived single-use merge execution; the base tip is read from `refs/heads/<base>`, never the cached `baseRefOid`. There is no administrative bypass, Done follows only an independently observed matching merge, and a protocol mismatch refuses with `server runs <sha>, CLI expects <sha>: deploy main first`.

## Merge queue

Every candidate lands on the same branch, so Graphyard serializes the final hop through one queue: a merge must not invalidate the candidates behind it. A candidate enters when it passes its own gates, and membership is derived, never requested — nobody can insert an entry, hold a position, reorder the queue or merge past the head. What a candidate is bound to, and when a review or proof is carried across a Graphyard-authored tip, is in [merge-queue bindings](protocol/merge-queue-binding.md).

## Trusted producers, smoke proof and review providers

A green job proves that a named check reported success, not that every behavioural criterion holds: a dedicated producer reads the actual report, verifies the code under test, and sends evidence with its own credential, granted only the proof names it can produce ([proofs in CI](first-pr.md#proofs-in-ci), [CI-produced evidence](protocol/evidence.md#ci-produced-evidence)). The post-deployment smoke proof and the `github`, `codex` and `agent` review providers are in [evidence](protocol/evidence.md#the-post-deployment-smoke-proof) and [review providers](protocol/github-webhook.md).

## Enforcement boundary

No transaction spans both systems: Graphyard controls its ledger immediately while check publication goes through a separate API, so a refusal and the revocation of a previously successful check can be separated by a delay, and GitHub never expires a check when Graphyard goes offline ([what the guarded merge does](architecture.md#the-merge-execution-boundary)). Cached reads are revalidated with ETags, count only after a `304 Not Modified`, and are bounded to 256 URL entries per process. A 429, or a 403 carrying `x-ratelimit-remaining: 0`, a `Retry-After` header or a rate-limit message, pauses that process's client for at least a minute; a 401, or a 403 without those signals, is a permission refusal and never pauses it. Concurrent jobs share one token refresh under the same cooldown, and draft or closed, unmerged pull requests wait at a refusing gate without dispatching review requests.

## Troubleshooting

- **GitHub reported disconnected, or a job shows 401:** App ID, installation ID, PEM secret and a server restart; a rejected key is a refusal, not a pause
- **Job shows 403 or is held:** `appPermissions` in `/api/status`; `master browser installation-accept`, or `github-setup --update-permissions`
- **Protection gate refuses:** Check name, App binding, `strict` left enabled, admin enforcement, force and delete settings
- **Acceptance refuses despite green CI:** Proof names, producer grant, candidate SHA, base SHA, policy revision, skipped count
- **PR changed while observed, or no update after a webhook:** Ordinary concurrency retry; signature secret and job errors, with polling as the fallback
