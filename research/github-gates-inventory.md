# GitHub-side gates and permissioning — inventory for cryptob1/graphyard (GY-1933)

Date: 2026-10-17. Scope: the **GitHub-side** layer of Graphyard — every gate, credential and
permission that lives in GitHub rather than in the control plane. The control plane's own gates
(leases, plannedFiles, independent review, proofs, merge only on green, two-party decisions) are
out of scope: they stay whatever happens here.

Operator direction this inventory serves (GY-1933 description): *"as little permissioning from Git
as possible, very much unconstrained, so agents can operate; don't over-engineer permissioning."*
Git access, not GitHub speed, keeps stalling delivery. **Detect-not-prevent is acceptable**: a
human pushing to main is reported by the main watch, not blocked.

## Method and evidence

- Source: this worktree at HEAD 9198a6c88f (files named per row).
- Live reads: the worker credential of this attempt (App installation token: `contents`,
  `pull_requests`, `workflows` write; `metadata` read) against `github.com/cryptob1/graphyard`:
  repository document (owner type `User`, `allow_auto_merge: true`), branch rules of `main`
  (empty — no rulesets), check runs on the merged PR #1315 and on candidate head `b5cb77b7`
  (`Graphyard / merge` and `graphyard/landable` published by App `graphyard-cryptob1-graphyard`;
  `test`/`typecheck` and shards published by `github-actions`), merged-by login on the five newest
  merged PRs (`app/graphyard-cryptob1-graphyard`).
- Deliberately **unreadable** with a worker credential (itself a permissioning finding): the
  classic branch-protection document and the environment/secret list (both need the App's
  `administration: read`), and the merger setting `/api/…` (readable by admin, coordinator,
  reader and operator-agent identities only). Their state is cited from the code that writes and
  reads them plus the observable effects named above.
- Measured latencies: the two daemon cursors on this host
  (`~/.config/graphyard/masters/315f05eed4a3245a5167.daemon.json` for this repository,
  `5e69f79fa209a4349c51.daemon.json` for the Snake install `cryptob1/graphyard-snake-v4`), field
  `latency[].approvalToMergeMs` — what the loop itself measured from the review gate passing
  (build + review green) to the observed merge (`src/daemon/metrics.ts`, `observeItemClock`).

## Summary table

| # | Gate (GitHub side) | Implements (files) | Protects against | Control-plane equivalent | What breaks if deleted | Verdict |
| - | --- | --- | --- | --- | --- | --- |
| 1 | Control-plane GitHub App + installation (`graphyard-cryptob1-graphyard`, App 4935393, installation 161493384) | `src/github-setup.ts`, `src/install/github.ts`, `src/github.ts`, `src/github-permissions.ts`, `.graphyard/github-app.json` | Nothing by itself — it is the single actor every automated GitHub act uses; its permission table bounds all automation | none — it *is* the control plane's GitHub side | Observation, check publication, auto-merge, review dispatch, worker push mints, base syncs, reruns all die; delivery stops in both merger modes | **keep** — it is the identity provider and observer for every other row |
| 2 | Reviewer App + head-named verdict comments (`graphyard-verdict`) | `src/github-setup.ts` (`--reviewer`), `src/reviewer.ts`, `src/agent-review.ts`, `src/review-post.ts` (github mode) | Verdicts posted by an identity that cannot push code (no `contents: write`, `checks`, `administration`), naming the exact head, never an implementer | review gate in `src/engine.ts`; control-plane verdict tokens (`src/review-post.ts`, `POST /api/work/:id/review-verdict`, GY-1525) — already enforced by the control plane | In github mode, agent review has no poster: every review-gated item stalls. After the merger switch: nothing — the API path already exists | **delete** (GitHub-side role only, after D1; item D3) — the gate itself stays |
| 3 | Revert-approver App (independent approver for main-guard reverts) | `src/github.ts` (`revertApproverFromEnv`), `src/install/github.ts` (`--role revert-approver`), `src/main-guard.ts` | The App that pushed a merge cannot approve its revert; only an exact-inverse diff is approved | none — the prevent-and-revert loop exists only in github mode; under the writer the trial refuses the push instead | Main-guard reverts can no longer merge (`require_last_push_approval` refuses); a red main stays red | **delete** (with row 17, item D4) |
| 4 | Classic branch protection on `main` (required approvals, App-bound checks, `enforce_admins`, no force-push/deletion, `strict` off) | `src/protection.ts` (`protectionPlan`, `applyProtection`, `conversationPayload`), `src/cli/master.ts` (`master protection --apply`), `src/master-browser.ts` | Any actor merging to main what Graphyard did not authorize on that exact head; admins included; strict off because the writer/queue merge on the base they were built on | under the control-plane merger: the writer's trial (`src/merge-writer/trial.ts`) + engine gates; the main watch as detector | In github mode: auto-merge merges without waiting for `Graphyard / merge` — the merge gate's GitHub half vanishes; force pushes to main become possible | **delete** after D1 (item D2) — superseded by row 9, which is stronger (binds admins too) |
| 5 | Auto-merge (`allow_auto_merge: true`, observed live; `enablePullRequestAutoMerge` with `expectedHeadOid`) | `src/protection.ts` (`mergeMode`, `enableAutoMergeArgs`, `ensureMergeMode`), `src/github.ts` (`autoMergeMutation`, `enqueuePullRequest`) | Merges happen only after every required check on the exact head is green (GitHub executes the merge) | the merge writer's trial-then-push (`src/merge-writer/executor.ts`) | With row 4 gone nothing merges automatically; in github mode delivery stops | **delete** after D1 (item D2) |
| 6 | Merge-queue ruleset "Graphyard merge queue" (+ repair-lane bypass, App-only, pull-request mode) | `src/protection.ts` (`mergeQueueRuleset`, `applyMergeQueue`, `repairBypassActor`) | Serialized merge groups, each one authorized head on the base it lands on; only the App may bypass, in PR mode | the writer's queue (`src/merge-writer/executor.ts` `mergeQueue`) — one head at a time, trial-tested | Absent here: user-owned repositories get HTTP 422 (`mergeMode` falls back to auto-merge; observed: no rulesets on `main`). Nothing to delete on this repository | **n/a here** (org installs only); the switch item D1 is where an org install would retire it |
| 7 | App-bound required checks `Graphyard / merge` + `graphyard/landable` (bound to the App, observed live on PR #1315's head) | `src/protection.ts` (`GRAPHYARD_CHECKS`, `requiredStatusChecks`), `src/github.ts` (`publish`), `src/landable-check.ts` | GitHub refusing any merge the control plane did not authorize on that exact sha; a new push invalidates the verdict (republished only on the current head; merged heads frozen, GY-1917) | engine gates + the writer's trial proofs (`criterionProofs`) | In github mode the merge gate is gone: policy verdicts never reach GitHub | **delete** after D1 (item D2) |
| 8 | Merge-writer deploy key (`graphyard-merge-writer-<host>`, ed25519, read-write) | `src/install/deploy-key.ts` (`ensureDeployKey`), `src/daemon/cycle-merge-writer.ts` (`pushEnvironment`) | The writer's push credential: repository-scoped SSH key, registered and fingerprint-checked, held 0600 under the install directory | none — it is the writer's hand | The writer cannot push merges; the switch (D1) cannot complete | **keep** — registered at the switch; it is what makes the control plane the only writer |
| 9 | Ruleset "Graphyard merge writer only" (creation/update/non-fast-forward/deletion refused for every actor; deploy keys bypass) | `src/protection.ts` (`mainWriteRuleset`, `mainWriteRulesetCurrent`), `src/install/deploy-key.ts` (`ensureMainWriteProtection`) | Any push to main by any actor — administrators included, which classic protection cannot promise — except the merge writer's deploy key | it **is** the control-plane-era write lock (GY-1715) | Any actor can push main again; only the main watch would notice (detect-not-prevent). Not yet applied here (github mode; `mainWriteRuleset` is applied only while the writer key is the repository's sole read-write deploy key) | **apply at D1, keep** thereafter |
| 10 | GitHub environment `uat` + secret `GRAPHYARD_RELEASE_TOKEN` (+ `UAT_URL`) | `src/master/release-filing.ts` (`provisionReleaseFiling`), `src/install/release-pipeline.ts` (`environment: uat`), `src/install/deploy-target.ts` (`--create-environments`) | The release-filing token is readable only by workflows running in the `uat` environment (candidate pipelines), never by pull-request code; `master setup --apply` issues/rotates the `graphyard-release-follow-up` identity behind it (scoped `intent:create`) | the identity is a control-plane principal (`src/operator-agent.ts`); GitHub is store + scoping only | Failed candidates file no holds/follow-ups (the recorded GY-1691 outage); UAT verification loses its URL | **keep** |
| 11 | GitHub environment `graphyard-reporting` + secrets `GRAPHYARD_CI_PRODUCER_TOKEN`, `GRAPHYARD_PRODUCER_TOKEN` (+ var `GRAPHYARD_URL`) | `.github/workflows/acceptance.yml` (plan/publish jobs: "Configure this environment to permit only main BEFORE storing its secrets") | Producer credentials usable only from `main`-ref jobs; candidate code is fetched only into an isolated build context (`pull_request_target` checks out main), so producer tokens never meet candidate code | proof authority and grants (`src/proof-grants.ts`; the CI producer is principal `trusted-acceptance`), producer sessions | CI-produced evidence dies; acceptance proofs fall back to producer sessions | **keep** |
| 12 | Webhook `POST /api/github/webhook` (HMAC verify, dedupe, wake) | `src/server` (webhook route), `src/github-setup.ts` (manifest registration), `docs/protocol/github-webhook.md` | Nothing repo-side — payloads never pass gates; it is the event feed that wakes observation | polling covers it (`observationCadence`, `src/github.ts`) | Slower observations and more App quota spend; nothing unsafe | **keep** |
| 13 | Worker session push credentials (per-attempt App installation tokens) | `src/worker-credential.ts`, `src/server/routes/work.ts` (`push-credential`), watch supervisor refresh/withdraw | Each attempt pushes with its own token: this repository only, `contents`/`pull_requests`/`workflows` write, one-hour expiry, withdrawn at session end; no host credential inside the sandbox | leases + plannedFiles (the engine refuses candidates outside planned files) | Workers cannot push (the recorded 2026-09-30 blackout: eleven items blocked on "could not read Username") | **keep** |
| 14 | Reviewer session binding + one-time verdict token | `src/review-post.ts` (`reviewBindingSchema`, control-plane mode), `src/reviewer.ts` (launch binding) | Exactly one verdict per launch, bound to head, base and policy revision; the token is never the reviewer's App token widened | same mechanism (it is the control plane's) | Verdicts cannot be posted; review stalls | **keep** |
| 15 | Operator `gh` login on the host + gh-pause | `src/install/github.ts` (`githubCli`), `src/gh-pause.ts`, `src/protection.ts` (`protectionRun`) | Nothing repo-side: it is the administrative hand (deploy-key registration, protection writes, secret stores); gh-pause pauses every ungoverned gh read on a rate-limit refusal | none | Setup and administration steps fail; the loop skips reads instead of burning the quota | **keep** |
| 16 | App request budgets + pacing (hourly budget, observation pacer, cadence bands, one-page compares) | `src/github.ts` (`GitHubBudget`, `TokenBudgets`, `ObservationPacer`, `observationCadence`, `comparePath`), `src/gh-pause.ts` | Spending the App's hourly quota or the gh login's rate limit (the 5 October merge burst is the recorded lesson: twenty candidates spent the hour in forty minutes) | none | 403s mid-observation; the loop stalls until reset | **keep** |
| 17 | Main guard (github-mode revert engine, job loop every 30 s) | `src/main-guard.ts`, `src/github.ts` (`guardGitHubMain`), row 3's revert-approver App | A merge that breaks main is reverted through a revert PR the independent App merges; flakes rerun once; cancelled runs escalate instead of reverting; the reverted item reopens for rework | the writer's trial runs build + proofs on the merge commit **before** push (prevention); candidate reverts on failed UAT (`src/release-revert.ts`); main watch (detection) | In github mode a red main stays red until an agent notices; joint merges keep breaking main. After D1 the path is dead code | **delete** after D1 (item D4) |
| 18 | Main watch (report-only; promotion freeze with `GRAPHYARD_MAIN_WATCH_FREEZE`; admin acknowledgement) | `src/daemon/main-watch.ts`, `src/routes/main-watch.ts` (route: `src/server/routes/main-watch.ts`) | Unexplained main commits (a human's direct push, anything no delivery/ledger/revert/window explains) are reported once per sha; with the freeze on, promotion holds until an admin acknowledges | it **is** the control plane's detector — the model for this whole layer | Manual pushes to main go unnoticed; delivery provenance drifts silently | **keep** |
| 19 | Required CI checks `test`/`typecheck` (`ci.yml`; `policy.checks` per item) | `.github/workflows/ci.yml`, `graphyard.json` policy, engine test gate (reads the check runs GitHub reports) | The control plane refuses a candidate whose CI did not pass on the exact head (the `test` gate reasons name the failing check) | the writer's trial runs the same proofs pre-push (`criterionProofs`) | In github mode the quality signal is gone; after D1 nothing — the trial covers it and the `pull_request` trigger is inert (no Graphyard PRs) | **keep** while github mode; trigger cleanup folds into D2 |
| 20 | `acceptance.yml` protected harness (`pull_request_target` from main; `graphyard/*` candidate branches only; forks never planned; attempt-scoped artifacts) | `.github/workflows/acceptance.yml`, `scripts/enumerate-ci-proofs.mjs`, `scripts/prepare-acceptance.mjs`, `scripts/publish-acceptance.mjs` | Proof integrity: candidate code never meets producer secrets; evidence is ciRun-bound to the exact job GitHub reports | ciRun-bound evidence verification (`src/server/routes/work.ts`, `isCiProducer`) | No CI-produced evidence; proofs fall back to producer sessions | **keep** |
| 21 | `Graphyard / install verification` neutral check run | `src/install/github.ts` (`VERIFICATION_CHECK`) | Nothing — a confirmation that webhook delivery works (explicitly not required) | none | Install verification loses its read-back | **keep** (trivial) |

## GitHub delivery mode vs the control-plane merger — measured

**What the two modes are.** `github` (this install's recorded merger; the item's direction dates
the choice to 2026-10-05, when the old internal merge queue managed about one merge per 26
minutes): GitHub executes the merge — the App publishes `Graphyard / merge` + `graphyard/landable`
on the exact head, enables auto-merge, and GitHub merges when the required checks pass.
`control-plane` (the shipped default since GY-1833; what the Snake install runs): the loop's merge
writer reconciles queued heads, runs a trial merge, runs the item's proofs on the merge commit,
then pushes once by deploy key (`src/merge-writer/trial.ts`, `src/merge-writer/executor.ts`,
`src/daemon/cycle-merge-writer.ts`).

**This repository — GitHub mode** (cursor `315f05eed4a3245a5167.daemon.json`, deliveries sampled on
2026-10-17; the item description's "p50 7.8 min, p90 46.2 min over 67 deliveries" is the same
population measured a few cycles earlier):

- 67 deliveries with an approval→merge measurement.
- p50 **7.6 min**, p90 **46.6 min**, mean 15.9 min, max **85.2 min**.
- 28 of 67 (42%) exceeded the loop's own 10-minute approval→merge p90 target
  (`latencyTargets.approvalToMergeP90Ms`, `src/daemon/metrics.ts`); 58 of 67 exceeded one minute;
  9 came in under a minute.
- The interval is pure GitHub merge machinery: the control-plane gates (CI `test`/`typecheck`,
  review, `Graphyard / merge`) are already green when the clock starts, so what is measured is
  required-check propagation plus auto-merge/queue wait.

**Snake install — control-plane merger** (`cryptob1/graphyard-snake-v4`, cursor
`5e69f79fa209a4349c51.daemon.json`, same day): 6 deliveries — GY-1 185.5 s (the install's first),
then GY-5 3.7 s, GY-6 3.9 s, GY-7 3.6 s, GY-10 4.0 s, GY-8 4.0 s; p50 **3.9 s** (65.5 s including
the first). Caveat for honesty: this interval includes the writer's queue wait, trial merge,
trial build + proofs and the push, and on the Snake repository those trials are near-instant
(small proof set). On this repository the trial pays the repository's own proof time inside the
interval — but that is the same suite github mode already runs as PR CI before the clock even
starts, paid once here instead of twice (PR run + queue/auto-merge re-validation), and it buys
**prevention**: a merge commit that fails its proofs is never pushed to main at all.

**Reading.** The measured difference is two orders of magnitude (minutes vs seconds) on the same
day, on the same loop code, with the same gate semantics. GitHub mode's latency is not GitHub
being slow at merging — it is the price of routing the merge decision through GitHub-side state
(required checks, queue position, auto-merge triggers) that the control plane then has to
observe and reconcile. Every gate rows 4–7 and 17 exist to make that detour safe. Under the
writer they are all redundant with machinery the control plane already runs.

## The switch: github → control-plane merger, and its rollback

Steps (each named by the code that performs it):

1. **Prove the writer ready.** The switch is refused while any shadow disagreement stands
   unexplained (GY-1560): the shadow gate (`run.shadow`, `src/server/shadow-verdict.ts`) must have
   compared writer trials against github merges and every shadow-only-fail or shadow-missed
   verdict must be explained.
2. **Flip the setting.** Admin credential: `graphyard master merger control-plane --reason TEXT`
   (`src/cli/merger.ts`, `src/merger-mode.ts`; append-only `policy.merger.set` event; admin-only;
   switching back to `github` is never refused).
3. **Give the writer its hand and lock the door.** `graphyard install --apply` registers the
   merge-writer deploy key (`ensureDeployKey`: ed25519, read-write, titled
   `graphyard-merge-writer-<host>`) and applies the "Graphyard merge writer only" ruleset
   (`ensureMainWriteProtection`, GY-1715). The ruleset step refuses unless the writer key is the
   repository's **only** read-write deploy key, and reports `operator-protected` instead of
   touching a branch the operator protects by other means.
4. **Let the loop land.** The writer reconciles intents, trial-merges, runs the proofs, pushes by
   deploy key and records the merge ledger entry. Workers submit heads (no pull requests);
   reviewer sessions receive head + base tip + a one-time verdict token. Cuts and promotions run
   on the loop's own cadence (`run.candidates.everyMerges` 5 / `idleMinutes` 15;
   `promoteEveryMinutes`).
5. **Retire the GitHub-side gates** — the deletion items below, each its own reviewed change,
   never in the same change as the switch.

Rollback (documented so no deletion can become irreversible):

1. **Lift the write lock first** — delete the "Graphyard merge writer only" ruleset; GitHub's
   deploy-key bypass would otherwise let only deploy keys push while github mode needs the App to
   merge pull requests.
2. `graphyard master merger github --reason TEXT` (never refused, no shadow precondition).
3. Recreate whatever the deletions removed, all by setup commands that already exist:
   `graphyard master protection --apply` (classic protection + auto-merge mode for a user-owned
   repository), `graphyard master reviewer setup` (reviewer App), `graphyard install --apply`
   (App permissions, environments), `graphyard master setup --apply` (uat release-filing secret).
4. `graphyard master tip-cleanup --apply` deletes leftover speculative-tip refs.
5. No work is lost in either direction: candidates, submissions and their evidence are
   control-plane records and survive the flip.

## Deletion items to file (left unreleased)

One item per delete row (rows 2+3/17 clustered where the same deletion serves both), each with
plannedFiles and a criterion that proves no control-plane gate is loosened. **Ordered so the
switch comes first**: rows 2, 3, 4, 5, 7 and 17 are safe to delete only once GitHub no longer
executes merges. The exact create payloads follow in Appendix A; AC-2's filing step and its
refusal for this attempt's identity are recorded at the end of this document.

## Appendix A — `graphyard master create` payloads, in filing order

File each from the coordinator checkout (the command needs `.graphyard/master.json`), in this
order, with dependencies added as noted. Leave every one unreleased (backlog, `ready: false` —
creation does not release; nothing below runs `ready`).

**D1 — first. The switch itself (makes the control-plane merger the only mode in use):**

```json
{
  "type": "feature",
  "title": "Switch cryptob1/graphyard to the control-plane merger as the only delivery mode",
  "policy": { "checks": ["test", "typecheck"], "review": true },
  "priority": 1,
  "plannedFiles": ["docs/delivery.md", "docs/github.md", "docs/operations.md"],
  "description": "GY-1933 D1. Operational switch + docs. Steps: shadow gate clean (GY-1560), 'graphyard master merger control-plane', 'graphyard install --apply' (deploy key + 'Graphyard merge writer only' ruleset), loop lands deliveries without pull requests. Rollback: lift the ruleset, 'graphyard master merger github', 'graphyard master protection --apply', 'graphyard master tip-cleanup --apply' (research/github-gates-inventory.md, 'The switch').",
  "criteria": [
    { "id": "AC-1", "text": "The recorded merger of this install is control-plane (policy.merger.set with a reason, set by an admin identity), the 'Graphyard merge writer only' ruleset is active on main, and the merge-writer deploy key is the repository's only read-write deploy key (GY-1715 exclusivity held).", "proofs": ["manual:merger-switch-recorded"] },
    { "id": "AC-2", "text": "At least five deliveries land through the merge writer: each has a merge-ledger entry whose merge commit's first parent is the previous tip, a recorded trial (build and proofs pass), and no pull request.", "proofs": ["manual:writer-deliveries-landed"] },
    { "id": "AC-3", "text": "The main watch reports no unexplained main commits across those deliveries, and the shadow verdicts preceding the switch showed no unexplained disagreement.", "proofs": ["manual:switch-clean-watch"] },
    { "id": "AC-4", "text": "No control-plane gate is loosened: every open item still requires independent review and its full proof set, no requirements revision weakened a criterion in the switch window (ledger check), and leases/plannedFiles enforcement is untouched.", "proofs": ["manual:switch-no-gate-loosened"] }
  ],
  "reason": "GY-1933 AC-2: measured approval-to-merge p50 7.6 min / p90 46.6 min under github mode vs seconds under the writer (Snake install, same day); the deletion items D2-D4 are safe only after this lands"
}
```

**D2 — after D1 (rows 4, 5, 7, 19's inert trigger):**

```json
{
  "type": "chore",
  "title": "Delete the GitHub-side merge gate: branch protection reconcile, App-bound required checks, auto-merge",
  "policy": { "checks": ["test", "typecheck"], "review": true },
  "priority": 2,
  "dependencies": ["<D1 id>"],
  "plannedFiles": ["src/protection.ts", "src/github.ts", "src/install/github.ts", "docs/github.md", "docs/delivery.md"],
  "description": "GY-1933 D2. Removes protectionPlan/applyProtection/ensureMergeMode, the publish() merge-gate and landable check-runs, auto-merge enqueue/dequeue and mergeQueueState, and turns allow_auto_merge off on GitHub. Rollback: graphyard install --apply + graphyard master protection --apply recreate all of it.",
  "criteria": [
    { "id": "AC-1", "text": "No code path publishes 'Graphyard / merge' or 'graphyard/landable', enables pull-request auto-merge, enqueues/dequeues a merge queue, or writes classic branch protection; 'master protection --apply' is gone or refuses with a pointer to the control-plane merger.", "proofs": ["manual:merge-gate-code-gone"] },
    { "id": "AC-2", "text": "On GitHub, allow_auto_merge is false on cryptob1/graphyard and classic protection on main is deleted, while the 'Graphyard merge writer only' ruleset still refuses creation, update, non-fast-forward and deletion of main for every actor including administrators.", "proofs": ["manual:github-merge-gate-absent"] },
    { "id": "AC-3", "text": "A delivery still lands end to end after the deletion (trial merge, proofs, deploy-key push, merge-ledger entry), and a candidate whose trial fails is refused with no push.", "proofs": ["manual:delivery-after-deletion"] },
    { "id": "AC-4", "text": "No control-plane gate is loosened: the engine's build/review/test gates and the writer's trial proof set are byte-for-byte unchanged (no test weakened, no criterion revised); the deletion removes only the GitHub mirror of decisions the control plane already makes.", "proofs": ["manual:merge-gate-no-loosening"] }
  ],
  "reason": "GY-1933 row 4/5/7 verdict delete after D1: GitHub-side enforcement of merge decisions the writer already makes, at a measured cost of minutes per merge"
}
```

**D3 — after D1 (row 2, GitHub-side role only):**

```json
{
  "type": "chore",
  "title": "Delete the reviewer App's GitHub-side role: verdicts post only through the control plane",
  "policy": { "checks": ["test", "typecheck"], "review": true },
  "priority": 2,
  "dependencies": ["<D1 id>"],
  "plannedFiles": ["src/agent-review.ts", "src/review-post.ts", "src/reviewer.ts", "src/github.ts", "src/github-setup.ts", "docs/github.md", "docs/coordination.md"],
  "description": "GY-1933 D3. Reviewer sessions stop authenticating to GitHub entirely: launch binding carries head, baseTip and a one-time verdict token; review post never runs gh. The review gate, reviewer independence and round caps are untouched. Reinstall path if the merger ever returns to github: graphyard master reviewer setup.",
  "criteria": [
    { "id": "AC-1", "text": "No reviewer session holds a GitHub credential and no code path reads or writes pull requests for review; agent-review verdict parsing of GitHub comments is gone, and the control-plane verdict route is the only verdict path.", "proofs": ["manual:reviewer-github-role-gone"] },
    { "id": "AC-2", "text": "The reviewer App installation can be removed from cryptob1/graphyard and review-gated deliveries still complete over a watched window (verdict tokens recorded, review gate passing only on independent approvals).", "proofs": ["manual:reviewer-app-removable"] },
    { "id": "AC-3", "text": "No control-plane gate is loosened: the review gate still refuses unapproved heads, the reviewer is still never an implementer of the item (identity checks unchanged), and review round caps still bind.", "proofs": ["manual:reviewer-no-loosening"] }
  ],
  "reason": "GY-1933 row 2 verdict delete after D1: the API verdict path (GY-1525) already enforces identity-bound review without a second App"
}
```

**D4 — after D1 (rows 3 and 17):**

```json
{
  "type": "chore",
  "title": "Delete the main guard's GitHub revert path; detection stays with the main watch",
  "policy": { "checks": ["test", "typecheck"], "review": true },
  "priority": 2,
  "dependencies": ["<D1 id>"],
  "plannedFiles": ["src/main-guard.ts", "src/github.ts", "docs/delivery.md", "docs/github.md"],
  "description": "GY-1933 D4. Removes guardGitHubMain and the revert-approver App wiring (a merge that breaks main is already impossible to push under the writer's trial; a failed UAT still reverts via candidate reverts). Detection stays with the main watch (report + promotion freeze + admin acknowledgement).",
  "criteria": [
    { "id": "AC-1", "text": "No code reads main's check runs to revert merges, opens revert pull requests, or wires a revert-approver App; the job loop no longer runs a main-guard tick.", "proofs": ["manual:main-guard-path-gone"] },
    { "id": "AC-2", "text": "Detection is preserved: a test shows the main watch raising attention for an unexplained main commit and, with the freeze on, holding promotion until an admin acknowledges it.", "proofs": ["manual:main-watch-detects"] },
    { "id": "AC-3", "text": "Prevention is preserved: a test shows the writer refusing to push a merge commit whose trial build or proofs fail (rework requested naming the failure), and candidate reverts on a failed UAT unchanged.", "proofs": ["manual:trial-still-prevents"] },
    { "id": "AC-4", "text": "No control-plane gate is loosened: the trial's proof selection and timeout bounds are unchanged and no criterion or policy revision rides along.", "proofs": ["manual:main-guard-no-loosening"] }
  ],
  "reason": "GY-1933 rows 3/17 verdict delete after D1: the guard repairs what the writer prevents; keeping dead repair code is over-engineering"
}
```

## AC-2 filing status for this attempt (recorded 2026-10-17)

The four payloads above are complete and ordered. Filing them is a `graphyard master create`
step, which this attempt's identity (worker `graphyard-claude-2`) is refused by design — the
engine allows `create` only to an admin or an operator-agent holding `intent:create` with
wildcard work scope (`src/engine.ts`, `authorizeOperatorCommand`; `src/model/refusal.ts`,
`admin()`), and the CLI itself runs only from the coordinator checkout where
`.graphyard/master.json` lives. Both refusals are recorded verbatim in this attempt's blocker;
the master takes the step from the coordinator checkout and unblocks.
