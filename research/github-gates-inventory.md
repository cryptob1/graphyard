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

- Source: base commit 9198a6c88f of `main` (files named per row).
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
  `latency[].approvalToMergeMs` (review + build green → merge, CI may still be running) and
  `latency[].mergeableToMergeMs` (every gate green → merge), plus `shadow[].durationMs` (this
  install's writer trials) — what the loop itself measured (`src/daemon/metrics.ts`,
  `observeItemClock`).

## Summary table

| # | Gate (GitHub side) | Implements (files) | Protects against | Control-plane equivalent | What breaks if deleted | Verdict |
| - | --- | --- | --- | --- | --- | --- |
| 1 | Control-plane GitHub App + installation (`graphyard-cryptob1-graphyard`, App 4935393, installation 161493384) | `src/github-setup.ts`, `src/install/github.ts`, `src/github.ts`, `src/github-permissions.ts`, `.graphyard/github-app.json` | Nothing by itself — it is the single actor every automated GitHub act uses; its permission table bounds all automation | none — it *is* the control plane's GitHub side | Observation, check publication, auto-merge, review dispatch, worker push mints, base syncs, reruns all die; delivery stops in both merger modes | **keep** — it is the identity provider and observer for every other row |
| 2 | Reviewer App + head-named verdict comments (`graphyard-verdict`) | `src/github-setup.ts` (`--reviewer`), `src/reviewer.ts`, `src/agent-review.ts`, `src/review-post.ts` (github mode) | Verdicts posted by an identity that cannot push code (no `contents: write`, `checks`, `administration`), naming the exact head, never an implementer | review gate in `src/engine.ts`; control-plane verdict tokens (`src/review-post.ts`, `POST /api/work/:id/review-verdict`, GY-1525) — already enforced by the control plane | In github mode, agent review has no poster: every review-gated item stalls. After the merger switch: nothing — the API path already exists | **delete** (GitHub-side role only, after D1; item D3, filed as GY-1936) — the gate itself stays |
| 3 | Revert-approver App (independent approver for main-guard reverts) | `src/install/index.ts` (`revertApproverEnv`, `app import --role revert-approver`), `src/github-setup.ts` (`appRoles`), `src/main-guard.ts` (`approveRevert`) | The App that pushed a merge cannot approve its revert; only an exact-inverse diff is approved | none — the prevent-and-revert loop exists only in github mode; under the writer the trial refuses the push instead | Main-guard reverts can no longer merge (`require_last_push_approval` refuses); a red main stays red | **delete** after D4 (item D7) |
| 4 | Classic branch protection on `main` (required approvals, App-bound checks, `enforce_admins`, no force-push/deletion, `strict` off) | `src/protection.ts` (`protectionPlan`, `applyProtection`, `conversationPayload`), `src/cli/master.ts` (`master protection --apply`), `src/master-browser.ts` | Any actor merging to main what Graphyard did not authorize on that exact head; admins included; strict off because the writer/queue merge on the base they were built on | under the control-plane merger: the writer's trial (`src/merge-writer/trial.ts`) + engine gates; the main watch as detector | In github mode: auto-merge merges without waiting for `Graphyard / merge` — the merge gate's GitHub half vanishes; force pushes to main become possible | **delete** after D1 (item D2, GY-1935, narrowed to this row) — superseded by row 9, which is stronger (binds admins too) |
| 5 | Auto-merge (`allow_auto_merge: true`, observed live; `enablePullRequestAutoMerge` with `expectedHeadOid`) | `src/protection.ts` (`mergeMode`, `enableAutoMergeArgs`, `ensureMergeMode`), `src/github.ts` (`autoMergeMutation`, `enqueuePullRequest`) | Merges happen only after every required check on the exact head is green (GitHub executes the merge) | the merge writer's trial-then-push (`src/merge-writer/executor.ts`) | With row 4 gone nothing merges automatically; in github mode delivery stops | **delete** after D1 (item D5) |
| 6 | Merge-queue ruleset "Graphyard merge queue" (+ repair-lane bypass, App-only, pull-request mode) | `src/protection.ts` (`mergeQueueRuleset`, `applyMergeQueue`, `repairBypassActor`) | Serialized merge groups, each one authorized head on the base it lands on; only the App may bypass, in PR mode | the writer's queue (`src/merge-writer/executor.ts` `mergeQueue`) — one head at a time, trial-tested | Absent here: user-owned repositories get HTTP 422 (`mergeMode` falls back to auto-merge; observed: no rulesets on `main`). Nothing to delete on this repository | **n/a here** (org installs only); the switch item D1 is where an org install would retire it |
| 7 | App-bound required checks `Graphyard / merge` + `graphyard/landable` (bound to the App, observed live on PR #1315's head) | `src/protection.ts` (`GRAPHYARD_CHECKS`, `requiredStatusChecks`), `src/github.ts` (`publish`), `src/landable-check.ts` | GitHub refusing any merge the control plane did not authorize on that exact sha; a new push invalidates the verdict (republished only on the current head; merged heads frozen, GY-1917) | engine gates + the writer's trial proofs (`criterionProofs`) | In github mode the merge gate is gone: policy verdicts never reach GitHub | **delete** after D1 (item D6) |
| 8 | Merge-writer deploy key (`graphyard-merge-writer-<host>`, ed25519, read-write) | `src/install/deploy-key.ts` (`ensureDeployKey`), `src/daemon/cycle-merge-writer.ts` (`pushEnvironment`) | The writer's push credential: repository-scoped SSH key, registered and fingerprint-checked, held 0600 under the install directory | none — it is the writer's hand | The writer cannot push merges; the switch (D1) cannot complete | **keep** — registered at the switch; it is what makes the control plane the only writer |
| 9 | Ruleset "Graphyard merge writer only" (creation/update/non-fast-forward/deletion refused for every actor; deploy keys bypass) | `src/protection.ts` (`mainWriteRuleset`, `mainWriteRulesetCurrent`), `src/install/deploy-key.ts` (`ensureMainWriteProtection`) | Any push to main by any actor — administrators included, which classic protection cannot promise — except the merge writer's deploy key | it **is** the control-plane-era write lock (GY-1715) | Any actor can push main again; only the main watch would notice (detect-not-prevent). Not yet applied here (github mode; `mainWriteRuleset` is applied only while the writer key is the repository's sole read-write deploy key) | **apply at D1, keep** thereafter |
| 10 | GitHub environment `uat` + secret `GRAPHYARD_RELEASE_TOKEN` (+ `UAT_URL`) | `src/master/release-filing.ts` (`provisionReleaseFiling`), `src/install/release-pipeline.ts` (`environment: uat`), `src/install/deploy-target.ts` (`--create-environments`) | The release-filing token is readable only by workflows running in the `uat` environment (candidate pipelines), never by pull-request code; `master setup --apply` issues/rotates the `graphyard-release-follow-up` identity behind it (scoped `intent:create`) | the identity is a control-plane principal (`src/operator-agent.ts`); GitHub is store + scoping only | Failed candidates file no holds/follow-ups (the recorded GY-1691 outage); UAT verification loses its URL | **keep** |
| 11 | GitHub environment `graphyard-reporting` + secrets `GRAPHYARD_CI_PRODUCER_TOKEN`, `GRAPHYARD_PRODUCER_TOKEN` (+ var `GRAPHYARD_URL`) | `.github/workflows/acceptance.yml` (plan/publish jobs: "Configure this environment to permit only main BEFORE storing its secrets") | Producer credentials usable only from `main`-ref jobs; candidate code is fetched only into an isolated build context (`pull_request_target` checks out main), so producer tokens never meet candidate code | proof authority and grants (`src/proof-grants.ts`; the CI producer is principal `trusted-acceptance`), producer sessions | CI-produced evidence dies; acceptance proofs fall back to producer sessions | **keep** |
| 12 | Webhook `POST /api/github/webhook` (HMAC verify, dedupe, wake) | `src/server` (webhook route), `src/github-setup.ts` (manifest registration), `docs/protocol/github-webhook.md` | Nothing repo-side — payloads never pass gates; it is the event feed that wakes observation | polling covers it (`observationCadence`, `src/github.ts`) | Slower observations and more App quota spend; nothing unsafe | **keep** |
| 13 | Worker session push credentials (per-attempt App installation tokens) | `src/worker-credential.ts`, `src/server/routes/work.ts` (`push-credential`), watch supervisor refresh/withdraw | Each attempt pushes with its own token: this repository only, `contents`/`pull_requests`/`workflows` write, one-hour expiry, withdrawn at session end; no host credential inside the sandbox | leases + plannedFiles (the engine refuses candidates outside planned files) | Workers cannot push (the recorded 2026-09-30 blackout: eleven items blocked on "could not read Username") | **keep** |
| 14 | Reviewer session binding + one-time verdict token | `src/review-post.ts` (`reviewBindingSchema`, control-plane mode), `src/reviewer.ts` (launch binding) | Exactly one verdict per launch, bound to head, base and policy revision; the token is never the reviewer's App token widened | same mechanism (it is the control plane's) | Verdicts cannot be posted; review stalls | **keep** |
| 15 | Operator `gh` login on the host + gh-pause | `src/install/github.ts` (`githubCli`), `src/gh-pause.ts`, `src/protection.ts` (`protectionRun`) | Nothing repo-side: it is the administrative hand (deploy-key registration, protection writes, secret stores); gh-pause pauses every ungoverned gh read on a rate-limit refusal | none | Setup and administration steps fail; the loop skips reads instead of burning the quota | **keep** |
| 16 | App request budgets + pacing (hourly budget, observation pacer, cadence bands, one-page compares) | `src/github.ts` (`GitHubBudget`, `TokenBudgets`, `ObservationPacer`, `observationCadence`, `comparePath`), `src/gh-pause.ts` | Spending the App's hourly quota or the gh login's rate limit (the 5 October merge burst is the recorded lesson: twenty candidates spent the hour in forty minutes) | none | 403s mid-observation; the loop stalls until reset | **keep** |
| 17 | Main guard (github-mode revert engine, job loop every 30 s) | `src/main-guard.ts`, `src/github.ts` (`guardGitHubMain`), row 3's revert-approver App | A merge that breaks main is reverted through a revert PR the independent App merges; flakes rerun once; cancelled runs escalate instead of reverting; the reverted item reopens for rework | the writer's trial runs build + proofs on the merge commit **before** push (prevention); candidate reverts on failed UAT (`src/release-revert.ts`); main watch (detection) | In github mode a red main stays red until an agent notices; joint merges keep breaking main. After D1 the path is dead code | **delete** after D1 (item D4, GY-1937, narrowed to this row) |
| 18 | Main watch (report-only; promotion freeze with `GRAPHYARD_MAIN_WATCH_FREEZE`; admin acknowledgement) | `src/daemon/main-watch.ts`, `src/server/routes/main-watch.ts` | Unexplained main commits (a human's direct push, anything no delivery/ledger/revert/window explains) are reported once per sha; with the freeze on, promotion holds until an admin acknowledges | it **is** the control plane's detector — the model for this whole layer | Manual pushes to main go unnoticed; delivery provenance drifts silently | **keep** |
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

**What each clock measures** (`observeItemClock`, `src/daemon/metrics.ts`). `approvedAt` is
stamped on the first cycle the `review` and `build` gates both pass; the `test` gate (CI
`test`/`typecheck`) need **not** have passed yet, so approval→merge includes whatever CI time
remains after approval. `mergeableAt` is stamped on the first cycle `mergeableCandidate`
(`src/daemon/decisions.ts`) holds: stage `merge`, a candidate, no violations, **every** gate
passed. mergeable→merge is therefore the only interval that isolates post-green merge delay.

**This repository — GitHub mode** (latency samples in cursor `315f05eed4a3245a5167.daemon.json`,
read 2026-10-17T19:37Z; all 69 deliveries fall on 2026-10-17 — the item description's "p50 7.8
min, p90 46.2 min over 67 deliveries" is the same population read two deliveries earlier):

- approval→merge, 69 deliveries: p50 7.8 min, p90 47.1 min, max 85.2 min. This is mostly CI, not
  merging: on the 19 deliveries that carry both clocks, approval→all-gates-green alone has p50
  8.1 min and p90 24.5 min.
- mergeable→merge (all gates green → merged), 19 deliveries: **18 measured 0 s** — the merge was
  already observed on the cycle that first saw every gate green, so GitHub's post-green delay is
  below the loop's observation resolution (cycle p50 39 s over the last 100 cycles). The one
  outlier is 17.3 min. The other 50 deliveries carry no mergeable sample at all, for the same
  reason: GitHub merged between two cycles, before the loop ever saw the item all-green and open.
- Conclusion: the earlier draft's reading — that approval→merge is "pure GitHub merge machinery"
  — was wrong. GitHub mode spends its minutes on CI after approval, and GitHub itself merges
  within one loop cycle of the last check turning green.

**Control-plane merger — measured.** Snake install (`cryptob1/graphyard-snake-v4`, cursor
`5e69f79fa209a4349c51.daemon.json`, same day): 6 deliveries, GY-1 185.5 s (the install's first),
then 3.6–4.0 s each. That interval includes the writer's trial build + proofs, which are
near-instant on Snake's small proof set, so it does **not** predict this repository. The
predictive number is this install's own shadow writer trials (`shadow`, same cursor; trial merge +
build + tests on the merge commit, 200 trials 2026-10-08..17): p50 **11.7 min**, p90 **14.1 min**
per trial — paid serially, one head at a time, after approval.

**Reading.** Measured honestly, the control-plane merger does **not** make delivery faster on this
repository: GitHub's own post-green delay is under one loop cycle, while the writer's serial trial
costs about 12 minutes per merge — the same CI time github mode already pays in parallel on the
pull request. The case for the switch is not latency; it is one authority per fact
(the GY-878 direction) and **prevention**: a merge commit whose trial fails is
never pushed, where github mode detects it after the fact (row 17). The deletion verdicts below
rest on that redundancy, not on merge speed, and D1 must keep the latency targets
(`latencyTargets`, `src/daemon/metrics.ts`) as a stated risk: at 12 min per serial trial, more
than about five deliveries an hour would queue behind the writer.

## The switch: github → control-plane merger, and its rollback

**No shipped command converts this install today.** `graphyard install --apply` never registers
the deploy key or applies the ruleset; that path is `graphyard up --merger control-plane`
(`src/up.ts`, `deploy-key` step then `ensureMainWriteProtection`), and `up --merger control-plane`
runs `install --no-github-app`, which refuses an install with a bound App (`docs/install.md`) —
this install has one. And `ensureMainWriteProtection` (`src/install/deploy-key.ts`) creates
nothing while classic protection exists: it returns `operator-protected` and leaves main as is,
which is not the writer-only lock. D1 therefore has to ship the conversion before it can run it.
The procedure, in order, each step's prerequisite checked before the next:

1. **Preflight, read-only — refuse to continue on any failure.**
   - Shadow gate clean: no unexplained shadow-only-fail / shadow-missed verdict (GY-1560;
     `unexplainedShadowDisagreements`, `src/server/shadow-verdict.ts`). `master merger` refuses on
     this too (409), but checking first keeps step 3 from being half done.
   - Deploy keys: `gh repo deploy-key list -R cryptob1/graphyard --json id,key,title,readOnly`
     shows no read-write key other than the writer's (`ensureMainWriteProtection` refuses
     otherwise; GitHub's deploy-key bypass covers every deploy key).
   - Record the current classic protection (`gh api repos/cryptob1/graphyard/branches/main/protection`)
     to a file: rollback restores from it, and `master protection --apply` reproduces it.
   - Throughput: the writer's trial p50 (12 min above) is accepted against the open queue.
2. **Register the writer's key** — `ensureDeployKey` (ed25519, read-write,
   `graphyard-merge-writer-<host>`, held 0600 under the install directory). Harmless while github
   mode stands: classic protection refuses a deploy key's direct push to main. D1 ships this as a
   command for an App-backed install (today only `up --merger control-plane` and the loop's
   stall remedy `renewDeployKey`, `src/daemon/step-stalls.ts`, call it).
3. **Swap the lock, with the loop paused** (no candidate observed or merged mid-swap):
   1. Create the "Graphyard merge writer only" ruleset (`mainWriteRuleset('main')`,
      `src/protection.ts`) **while classic protection still stands**. From this moment GitHub
      refuses every merge but a deploy-key push — the App's auto-merge included — so no PR can
      merge through the gap. D1 must add this transition to `ensureMainWriteProtection` (create
      Graphyard's ruleset alongside classic protection when asked to transition, instead of
      returning `operator-protected`).
   2. Delete classic protection on main (it would also refuse the writer: deploy keys cannot
      bypass required reviews/checks). `ensureMainWriteProtection` then reports `unchanged`.
   3. `graphyard master merger control-plane --reason TEXT` (admin; `src/cli/merger.ts`,
      `src/merger-mode.ts`; append-only `policy.merger.set`).
   4. Resume the loop.
4. **Let the loop land.** The writer trial-merges, runs the proofs, pushes by deploy key and
   records the merge-ledger entry. Workers submit heads (no pull requests); reviewer sessions
   receive head + base tip + a one-time verdict token.
5. **Retire the remaining GitHub-side gates** — D2–D7 below, each its own reviewed change, never in
   the same change as the switch. (Classic protection is already gone at step 3.2; D2 removes the
   code that would recreate it.)

Rollback (documented so no deletion can become irreversible), loop paused:

1. Restore classic protection from the step-1 record (or `graphyard master protection --apply`)
   **before** lifting the ruleset, so main is never unprotected.
2. Delete the "Graphyard merge writer only" ruleset — while it stands, only deploy keys may update
   main and github mode's App merges are refused.
3. `graphyard master merger github --reason TEXT` (never refused, no shadow precondition).
4. Recreate whatever D2–D7 removed: `graphyard master protection --apply` (auto-merge mode),
   `graphyard master reviewer setup` (reviewer App), `graphyard install --apply` (App
   permissions, environments), `graphyard master setup --apply` (uat release-filing secret);
   `graphyard master tip-cleanup --apply` deletes leftover speculative-tip refs. Resume the loop.
5. No work is lost in either direction: candidates, submissions and their evidence are
   control-plane records and survive the flip.

## Deletion items (one per delete row, left unreleased)

Exactly one deletion item per delete row, each with plannedFiles and a last criterion that no
control-plane gate is loosened. **Ordered so the switch comes first**: every delete row is safe
only once GitHub no longer executes merges.

| Delete row | Item | Key | Depends on |
| --- | --- | --- | --- |
| — (the switch) | D1 | GY-1934 (filed) | — |
| 4 classic protection | D2 | GY-1935 (filed; narrowed by revision) | GY-1934 |
| 2 reviewer App role | D3 | GY-1936 (filed) | GY-1934 |
| 17 main guard | D4 | GY-1937 (filed; narrowed by revision) | GY-1934 |
| 5 auto-merge | D5 | to file | GY-1935 |
| 7 App-bound checks | D6 | to file | GY-1935 |
| 3 revert-approver App | D7 | to file | GY-1937 |

D5 and D6 depend on D2 (all three edit `src/protection.ts`), so they serialize after it; D7
waits for D4, the only caller of the revert approver. GY-1935 and GY-1937 were first filed with
rows 4+5+7 and 3+17 combined; the requirements revisions below narrow each to its own row.

## Appendix A — `graphyard master create` payloads, in filing order

Filed from the coordinator checkout (the command needs `.graphyard/master.json`) in this order;
each payload is the record of what was filed, and `<D1 id>` resolved to GY-1934's id
`6a2e38be-c883-438d-9d60-82be2f420aa8` at filing. The filing identity widened only plannedFiles,
adding `tests/docs-budget.test.ts` to each item (docs edits move the word budget); every one is
unreleased (backlog, `ready: false` — creation does not release; nothing below runs `ready`).

**D1 — first. The switch itself (makes the control-plane merger the only mode in use).**
Filed as **GY-1934** (2026-10-17T19:12:49Z, backlog):

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

**D1 requirements revision owed before GY-1934 is released.** The filed payload above predates
the corrected switch procedure: its description names `graphyard install --apply` as the
provisioning step (it is not one) and its reason cites a latency gain the corrected measurement
does not show. Before release, the operator revises GY-1934 (`graphyard requirements GY-1934 FILE`,
operator-only; this worker identity cannot) to this file:

```json
{
  "expectedPolicyRevision": 1,
  "reason": "GY-1933 review: the filed D1 named a provisioning step that does not convert an App-backed install, and the case for the switch is one authority per fact plus prevention, not latency (writer trial p50 11.7 min here). GY-1933 D1. Convert this App-backed github-mode install to the control-plane merger, following research/github-gates-inventory.md 'The switch': read-only preflight (shadow clean, no other read-write deploy key, classic protection recorded, throughput accepted); a command that registers the writer deploy key on an App-backed install; with the loop paused, create the 'Graphyard merge writer only' ruleset alongside classic protection (a transition ensureMainWriteProtection does not do today), delete classic protection, then 'graphyard master merger control-plane'. Rollback restores classic protection before lifting the ruleset.",
  "criteria": [
    {
      "id": "AC-1",
      "text": "A shipped command registers the merge-writer deploy key on an App-backed install and refuses before writing anything when any preflight check fails (unexplained shadow disagreement, another read-write deploy key, unreadable classic protection); tests cover each refusal.",
      "proofs": [
        "manual:switch-preflight-refuses"
      ]
    },
    {
      "id": "AC-2",
      "text": "The protection transition creates 'Graphyard merge writer only' while classic protection stands and reports created, never operator-protected; a test shows no window in which main has neither classic protection nor the ruleset, in the switch and in the rollback.",
      "proofs": [
        "manual:protection-transition-gapless"
      ]
    },
    {
      "id": "AC-3",
      "text": "On cryptob1/graphyard: the recorded merger is control-plane (policy.merger.set by an admin, with a reason), the ruleset is active on main, classic protection is gone, the writer key is the only read-write deploy key, and at least five deliveries land through the writer (merge-ledger entry, first parent the previous tip, recorded passing trial, no pull request) with no unexplained main-watch commit.",
      "proofs": [
        "manual:merger-switch-recorded"
      ]
    },
    {
      "id": "AC-4",
      "text": "No control-plane gate is loosened: every open item still requires independent review and its full proof set, no requirements revision weakened a criterion in the switch window, and leases/plannedFiles enforcement is untouched.",
      "proofs": [
        "manual:switch-no-gate-loosened"
      ]
    }
  ],
  "dependencies": [],
  "plannedFiles": [
    "src/install/deploy-key.ts",
    "src/cli/merger.ts",
    "src/merger-mode.ts",
    "tests/main-write-protection.test.ts",
    "tests/deploy-key.test.ts",
    "tests/merger-setting.test.ts",
    "tests/docs-budget.test.ts",
    "docs/delivery.md",
    "docs/github.md",
    "docs/operations.md"
  ],
  "exclusiveResources": []
}
```

**Test paths.** The D2 and D4 revisions and D5–D7 below carry their code tests; GY-1936 still
lists none, so widen it at release with `tests/review-post.test.ts`.

**D2 — after D1 (row 4).**
Filed as **GY-1935** (depends on GY-1934, backlog) with rows 4, 5 and 7 combined, as recorded here:

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

**D2 requirements revision — narrows GY-1935 to row 4** (`graphyard requirements GY-1935 FILE`,
operator-only; requirements revisions take no description, so the narrowing is in the reason):

```json
{
  "expectedPolicyRevision": 1,
  "reason": "GY-1933 review 90ba4739ae: one deletion item per delete row; GY-1935 narrows to row 4, rows 5 and 7 move to D5 and D6. GY-1933 D2, row 4 only. Removes the classic branch-protection reconcile (protectionPlan, applyProtection, conversationPayload) and 'master protection --apply' recreating it; classic protection itself is already deleted by D1's lock swap. Auto-merge (D5) and the App-bound checks (D6) are separate items. Rollback: restore classic protection from D1's preflight record before lifting the writer ruleset.",
  "criteria": [
    {
      "id": "AC-1",
      "text": "No code path writes classic branch protection on main; 'master protection --apply' is gone or refuses with a pointer to the control-plane merger, and protection tests cover the refusal.",
      "proofs": [
        "manual:classic-protection-code-gone"
      ]
    },
    {
      "id": "AC-2",
      "text": "On GitHub, classic protection on main is absent while the 'Graphyard merge writer only' ruleset still refuses creation, update, non-fast-forward and deletion of main for every actor including administrators.",
      "proofs": [
        "manual:writer-ruleset-still-binds"
      ]
    },
    {
      "id": "AC-3",
      "text": "A delivery still lands end to end after the deletion (trial merge, proofs, deploy-key push, merge-ledger entry), and a candidate whose trial fails is refused with no push.",
      "proofs": [
        "manual:delivery-after-protection-deletion"
      ]
    },
    {
      "id": "AC-4",
      "text": "No control-plane gate is loosened: the engine's build/review/test gates and the writer's trial proof set are unchanged (no test weakened, no criterion revised); the deletion removes only the GitHub mirror of decisions the control plane already makes.",
      "proofs": [
        "manual:protection-no-loosening"
      ]
    }
  ],
  "dependencies": [
    "6a2e38be-c883-438d-9d60-82be2f420aa8"
  ],
  "plannedFiles": [
    "src/protection.ts",
    "src/cli/master.ts",
    "src/master-browser.ts",
    "tests/protection-restore.test.ts",
    "tests/protection-operator-rulesets.test.ts",
    "tests/docs-budget.test.ts",
    "docs/github.md",
    "docs/delivery.md"
  ],
  "exclusiveResources": []
}
```

**D3 — after D1 (row 2, GitHub-side role only).**
Filed as **GY-1936** (depends on GY-1934, backlog):

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

**D4 — after D1 (row 17).**
Filed as **GY-1937** (depends on GY-1934, backlog) with rows 3 and 17 combined, as recorded here:

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

**D4 requirements revision — narrows GY-1937 to row 17** (`graphyard requirements GY-1937 FILE`):

```json
{
  "expectedPolicyRevision": 1,
  "reason": "GY-1933 review 90ba4739ae: one deletion item per delete row; GY-1937 narrows to row 17, row 3 moves to D7. GY-1933 D4, row 17 only. Removes guardGitHubMain and the job loop's main-guard tick (a merge that breaks main cannot be pushed under the writer's trial; a failed UAT still reverts via candidate reverts). Detection stays with the main watch. The revert-approver App wiring (row 3) is D7, after this item.",
  "criteria": [
    {
      "id": "AC-1",
      "text": "No code reads main's check runs to revert merges or opens revert pull requests, and the job loop no longer runs a main-guard tick.",
      "proofs": [
        "manual:main-guard-path-gone"
      ]
    },
    {
      "id": "AC-2",
      "text": "Detection is preserved: a test shows the main watch raising attention for an unexplained main commit and, with the freeze on, holding promotion until an admin acknowledges it.",
      "proofs": [
        "manual:main-watch-detects"
      ]
    },
    {
      "id": "AC-3",
      "text": "Prevention is preserved: a test shows the writer refusing to push a merge commit whose trial build or proofs fail (rework requested naming the failure), and candidate reverts on a failed UAT unchanged.",
      "proofs": [
        "manual:trial-still-prevents"
      ]
    },
    {
      "id": "AC-4",
      "text": "No control-plane gate is loosened: the trial's proof selection and timeout bounds are unchanged and no criterion or policy revision rides along.",
      "proofs": [
        "manual:main-guard-no-loosening"
      ]
    }
  ],
  "dependencies": [
    "6a2e38be-c883-438d-9d60-82be2f420aa8"
  ],
  "plannedFiles": [
    "src/main-guard.ts",
    "src/github.ts",
    "tests/main-guard.test.ts",
    "tests/soak-main-guard.test.ts",
    "tests/docs-budget.test.ts",
    "docs/delivery.md",
    "docs/github.md"
  ],
  "exclusiveResources": []
}
```

**D5 — after D2 (row 5).** To file (`master create`); its dependency is GY-1935's id:

```json
{
  "type": "chore",
  "title": "Delete pull-request auto-merge: GitHub no longer executes merges",
  "policy": { "checks": ["test", "typecheck"], "review": true },
  "priority": 2,
  "dependencies": ["6c5c862e-9a03-4ad0-9730-088feff05c17"],
  "plannedFiles": ["src/protection.ts", "src/github.ts", "tests/protection-merge-mode.test.ts", "tests/protection-merge-mode-persistence.test.ts", "tests/docs-budget.test.ts", "docs/github.md", "docs/delivery.md"],
  "description": "GY-1933 D5, row 5. After D1 (via D2, which shares src/protection.ts): removes mergeMode/enableAutoMergeArgs/ensureMergeMode and autoMergeMutation/enqueuePullRequest, and turns allow_auto_merge off on cryptob1/graphyard. Rollback: 'graphyard master protection --apply' in a github-mode install re-enables it.",
  "criteria": [
    { "id": "AC-1", "text": "No code path enables pull-request auto-merge or enqueues/dequeues a merge queue, and the merge-mode tests are removed or rewritten to assert the absence.", "proofs": ["manual:auto-merge-code-gone"] },
    { "id": "AC-2", "text": "On GitHub, allow_auto_merge is false on cryptob1/graphyard, and deliveries still land through the merge writer (merge-ledger entry, no pull request merged by GitHub).", "proofs": ["manual:auto-merge-off-deliveries-land"] },
    { "id": "AC-3", "text": "No control-plane gate is loosened: the engine's build/review/test gates and the writer's trial proof set are unchanged (no test weakened, no criterion revised).", "proofs": ["manual:auto-merge-no-loosening"] }
  ],
  "reason": "GY-1933 row 5 verdict delete after D1: the merge writer's trial-then-push executes every merge; GitHub auto-merge is a second executor"
}
```

**D6 — after D2 (row 7).** To file; its dependency is GY-1935's id:

```json
{
  "type": "chore",
  "title": "Delete the App-bound required checks 'Graphyard / merge' and 'graphyard/landable'",
  "policy": { "checks": ["test", "typecheck"], "review": true },
  "priority": 2,
  "dependencies": ["6c5c862e-9a03-4ad0-9730-088feff05c17"],
  "plannedFiles": ["src/protection.ts", "src/github.ts", "src/landable-check.ts", "tests/landable-check.test.ts", "tests/docs-budget.test.ts", "docs/github.md", "docs/delivery.md"],
  "description": "GY-1933 D6, row 7. After D1 (via D2, which shares src/protection.ts): removes GRAPHYARD_CHECKS/requiredStatusChecks, publish()'s merge-gate check run and src/landable-check.ts. Rollback: a github-mode install republishes them after 'graphyard master protection --apply'.",
  "criteria": [
    { "id": "AC-1", "text": "No code path publishes 'Graphyard / merge' or 'graphyard/landable' check runs, and no protection or ruleset payload requires them; the landable-check tests are removed or rewritten to assert the absence.", "proofs": ["manual:app-checks-code-gone"] },
    { "id": "AC-2", "text": "On GitHub, a new candidate head carries neither check run and still lands through the merge writer, and a candidate whose trial fails is refused with no push.", "proofs": ["manual:app-checks-absent-delivery"] },
    { "id": "AC-3", "text": "No control-plane gate is loosened: the engine's build/review/test gates and the writer's trial proof set are unchanged (no test weakened, no criterion revised).", "proofs": ["manual:app-checks-no-loosening"] }
  ],
  "reason": "GY-1933 row 7 verdict delete after D1: the checks mirror to GitHub verdicts the engine and the writer's trial already enforce"
}
```

**D7 — after D4 (row 3).** To file; its dependency is GY-1937's id:

```json
{
  "type": "chore",
  "title": "Delete the revert-approver App role",
  "policy": { "checks": ["test", "typecheck"], "review": true },
  "priority": 2,
  "dependencies": ["d0f36211-eecd-4056-ab1d-79730652e59d"],
  "plannedFiles": ["src/install/index.ts", "src/github-setup.ts", "src/main-guard.ts", "tests/app-import.test.ts", "tests/docs-budget.test.ts", "docs/github.md", "docs/install.md"],
  "description": "GY-1933 D7, row 3. After D4 removes the main guard, the revert-approver App has no caller: removes the 'revert-approver' App role (appRoles, app import --role revert-approver), revertApproverEnv and its env wiring, and approveRevert if D4 left it. The App installation can then be removed from cryptob1/graphyard.",
  "criteria": [
    { "id": "AC-1", "text": "No code registers, imports, reads or wires a revert-approver App; 'app import --role revert-approver' is refused with a pointer to the main watch, and a test covers the refusal.", "proofs": ["manual:revert-approver-code-gone"] },
    { "id": "AC-2", "text": "The revert-approver App installation is removed from cryptob1/graphyard and the main watch still raises attention for an unexplained main commit.", "proofs": ["manual:revert-approver-removable"] },
    { "id": "AC-3", "text": "No control-plane gate is loosened: the review gate's reviewer-independence checks, the writer's trial proof set and candidate reverts on a failed UAT are unchanged.", "proofs": ["manual:revert-approver-no-loosening"] }
  ],
  "reason": "GY-1933 row 3 verdict delete after D4: the App approves only main-guard reverts, which D4 removes"
}
```

## AC-2 filing status (recorded 2026-10-17; attempt 5)

Filed by the master coordinator, each left unreleased:

| Item | Key | Filed (UTC) | Id | Depends on | State |
| - | --- | --- | --- | --- | --- |
| D1 switch | GY-1934 | 2026-10-17T19:12:49Z | `6a2e38be-c883-438d-9d60-82be2f420aa8` | — | backlog, `ready: false` |
| D2 classic protection | GY-1935 | 2026-10-17T19:13:15Z | `6c5c862e-9a03-4ad0-9730-088feff05c17` | GY-1934 | backlog, `ready: false` |
| D3 reviewer App role | GY-1936 | 2026-10-17T19:13:18Z | `455c56f3-8cbe-4f25-953e-6b3f7f4daea3` | GY-1934 | backlog, `ready: false` |
| D4 main guard | GY-1937 | 2026-10-17T19:13:21Z | `d0f36211-eecd-4056-ab1d-79730652e59d` | GY-1934 | backlog, `ready: false` |

Owed by the master (the review of 90ba4739ae found rows 4/5/7 and 3/17 combined): the GY-1935
and GY-1937 revisions above, and filing D5, D6 and D7, unreleased. The worker identity
(`graphyard-claude-2`) is refused all of it: `graphyard create` and `graphyard requirements`
answer "Operator permission required" (403; `src/engine.ts` `authorizeOperatorCommand`),
after each payload above passed request validation; `graphyard master create` needs the
coordinator checkout's `.graphyard/master.json`. The GY-1934 revision is also owed (above).
