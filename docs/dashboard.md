<!-- page: Operate Graphyard | 3 | the dashboard page by page: what each number, sentence and marker means, and where everything else moved. -->
# Reading the dashboard

The dashboard answers three questions first: what is being worked on, what is stuck and why, and what shipped. Everything else is one click away. The plain-language version of this page is **How Graphyard works**, linked from the header of every dashboard page.

## Navigation

The sidebar has at most four entries.

| Entry | What it holds |
| --- | --- |
| **Work** | The home page: open items, grouped by what needs attention; and **Needs you**, the requests only a human may answer, as a tab. |
| **Shipped** | Every delivered item, newest first, with its pull request and whether the deployment serves it. |
| **Insights** | Shipping pulse, Flow analytics, Validation and Releases, as tabs. |
| **Settings** | Test cases, Proof authority and Operator automation, as tabs. |

A page is hidden when nothing is configured for it. An empty list and a failed read are told apart: Operator automation says the read failed and that what is configured is unknown, rather than reporting the safe bootstrap default it cannot see. Validation is hidden until a validation request exists or an item requires an `e2e:` scenario. Releases is hidden until a release or an environment exists. Operator automation is hidden until a scoped operator agent exists. Delivery slices are hidden until a slice has a lead. When the read that decides this fails, the page stays visible, so an outage never hides data. Operator automation is visible to admin sessions only. Operator-agent sessions do not see Shipping pulse or Flow analytics, because their scoped API cannot serve them.

The **Agent fleet** page is opened from the fleet line under the Work heading, or from Operator automation, the way the guide is opened from the header: it is not a tab. It shows the [agent registry](master-agent.md#the-agent-registry) — each role with its preference order, how many of its sessions are running against its concurrency limit, and the account its next action would run on; each account with its runtime, model, cost and capability, the roles it serves, its live sessions, login, quota and reset time, and, when it cannot take a session, the reason; each runtime's launch contract; and the recent selections with their reasons. Admin and coordinator sessions also get the forms that configure it — runtime, model, account, role, a quota mark, and removal — each with an audit reason; [onboarding](onboarding.md#configure-the-fleet) walks through them in order. The page names hosts and login homes, so worker, producer and operator-agent sessions do not see it.

## Needs you

**Work → Needs you** lists every open human-only request — a decision about goals and priorities, spending money or opening a third-party account, or issuing a credential to a person — longest wait first. Each card shows the item, the exact thing needed, which of the three decisions it is, who asked and why, how long it has waited, and the terminal command that answers it (`graphyard answer GY-N REQUEST ANSWER`). An item listed here holds no worker and delays nothing else.

A declared human `admin` session gets an answer box on the card. **Answer and resume** posts `work/GY-N/answer`; the item returns to the master loop, which dispatches it on its next cycle with the answer in the new worker's prompt — no master session is involved. **Decline** keeps it parked with your words as its blocker. Agent sessions see the requests but never the form, and the server refuses their answers. Recently answered requests stay listed underneath with the answer and how long it waited. On the home page a parked item reads `Stuck: Waiting on a human-only decision (…): NEEDED`.

## The status sentence

Every card, and the top of every item view, carries one sentence derived from the item's first refusing gate. It says what is happening, what happens next and who is on it, for example *Waiting for someone to pick this up*, *Alex is building it — no pull request yet*, *Waiting for review of PR #42* or *Stuck: needs a second Postgres instance*. The mapping from gate reasons to sentences lives in `web/plain-status.ts`. A reason it does not recognise reads as its step, for example *Waiting to merge*, and never as raw internal text.

**Stuck** means the item will not move until someone decides or fixes something: a recorded blocker, a standing escalation or lead hold, a merge conflict, a pull request that changes files outside its plan, no available reviewer, or a proof that no longer counts. Everything else is waiting its turn.

## How long it has held its status

Every work card carries one duration, always, with no control to press: **how long the item has held the status the card names**, not how old the item is. An item created three days ago and picked up two minutes ago reads `2m`; one created an hour ago that has waited fifty-five minutes reads `55m`. The item view carries the same number, beside the key.

**Past thirty minutes the duration turns red** and reads, in words, `1h 12m overdue`. That is the signal for an item that has stopped moving: thirty minutes is past the loop's twenty-minute idle-but-actionable bound and equal to the thirty-minute p50 submit-to-merge target this repository measures itself against, so an item over it has stalled by the pipeline's own standard. Red is never the only cue: the word *overdue* and a triangle beside it carry the same meaning in greyscale, to a reader who cannot separate red from green, and to a screen reader, which announces the words and skips the triangle. The card itself is outlined in the same red, so a stalled item is visible from the shape of the list. A card in the merge queue carries the same duration and outline as the item's card in the lists, and gives its time in the queue separately, after the entry's position.

The threshold is one configured value, `OVERDUE_MINUTES` in `web/duration.ts`, and no view carries a number of its own: the list, the board and the item view all read the verdict from `statusHeld` in `web/plain-status.ts`. The verdict is taken on the whole minutes the card renders, so nothing turns red while still reading `30m`.

The clock starts when the item entered its current status and restarts only when it enters a new one. A change that does not move the item — an observation, a heartbeat, a failed retry of the same action — leaves it running, so a stalled item cannot be made to look fresh by being looked at or checked in on. Three moves the stored stage does not see have their own instant, because the card's sentence does see them: handing the work in, which the build gate keeps in the build stage until the pull request is observed on GitHub; a claim, which after a send-back leaves the stage at build while the card turns from *Sent back for changes* to a builder at work, so the clock starts at that claim however long the item waited before it; and an attempt ending — a claim running out, work sent back — which reads as *Waiting for someone to pick this up* from the moment the builder left rather than from when it was claimed. Work sent back after it was handed in is never clocked from before that hand-in. Delivered work shows how long it has been delivered and never reads as overdue: it has arrived, not stalled. `tests/card-timing.test.ts` holds all of this, including a real item driven through a retry loop whose duration keeps climbing.

## The home page

The page counts open work in one place. Nothing is counted twice — not on the page, not beside it in the sidebar, and not in board view — and no total that is a sum of the row is drawn as its own tile.

- **The heading** carries the open total: *Work 7* is seven items not shipped yet. It is the sum of the count row, so it appears nowhere else: the sidebar's *Work* entry is a name, not a count.
- **The count row** is the one row of counts: the stages, in work order, each with its open items. A stage holding nothing is drawn not at all — no label, no zero, no placeholder — so the row is only as wide as there is work, and the whole row is absent when nothing is open. An item whose claim lapsed is under *Needs a worker*, not *Being built*, whatever its stored stage says. Click a stage to filter the lists to it, click it again to clear. *Show times* adds the oldest item and the p50/p95 time in each drawn stage; the per-item duration on the cards is never behind it. Delivered work is never in the row.
- **Lists** show *Stuck* first, then *In progress* and *Needs a worker*, oldest first within each; *Not started* is collapsed. Only *Stuck* carries a count, highlighted — it is the one count for work needing attention, and it counts items, not gate reasons. The other headings name a group the row already counts, so they repeat no number.
- **Board view** draws a column for every open stage, empty ones included, because a board is read as a fixed set of columns and a missing one would read as a stage that no longer exists. A column is headed by its stage name alone: the count row above it already says how many, so no column repeats the number.
- **Shipped this week** lists items merged in the last seven days and links to Shipped.

The numbers come from one function, `homeNumbers` in `web/home-numbers.ts`, and `unit:home-numbers-reconcile` asserts that they agree. It returns one field per number drawn — the row, the open total, the stuck count and the week's shipped count — and no per-stage alias beside the row. `unit:work-page-single-count-row` and `unit:work-page-no-derived-totals` hold the page to one count row and one home for each number; `integration:work-page-density` holds empty stages out of the default view.

## The item view

The item view opens with the key and how long the item has held its status, then the status sentence, the owner, the pull request and the single thing blocking progress. **Steps** lists the gates in order: passed steps get one line each, the current step shows its reasons in plain words, and later steps are collapsed. **What must be true** lists each acceptance criterion once, with one marker per proof: ✓ passed, ○ pending (or put off), × failed or withdrawn.

**More details** holds everything else: the description, type, priority, policy and revision, worker ID and assignment, workspaces, coordination diagnosis, file overlaps, merge-queue position, review provider, the raw gate reasons, proof details, bootstrap obligations, observed delivery, evidence with its artifacts, and history. Admin sessions get an **Edit** menu for actions that change the item's rules: switching the review provider, requesting a fresh provider review, and revising requirements.

## Shipping pulse

**Insights → Shipping pulse** summarizes repository delivery flow: exact merges per week, intent-to-merge, and the pull-request-to-production split. The full definitions and bounds are in [Shipping pulse](shipping-pulse.md); this section explains what the production figures on the page mean and how to make them measurable.

### What the pull-request-to-production split measures

For each delivery in the 12-week window the split runs from GitHub's observed pull-request creation time, through the exact accepted merge, to the first production instant recorded for that merge. The page shows the average, median and 90th percentile of the whole interval, the average of its two components (*PR created → merge* and *merge → production*), and a coverage line: how many deliveries in the window had a production instant, out of how many were eligible. Every instant is compared on the repository clock. Empty figures read `Unavailable`, never zero.

### Which observations feed it

Two sources give a delivery a production instant. A provider observation is preferred; the master's verification stands in only where no provider reported.

| Source | Recorded by | Instant used |
| --- | --- | --- |
| Deployment-provider observation | A collector posting `POST /api/production-observations` ([deployment observations](shipping-pulse.md#source-and-definitions)) with a `producer` credential whose `deploymentProviders` allowlist names the provider. The observation carries the deployment's own finish time, the measured clock bracket, and the exact merge commits it contains. | The earliest repository instant the deployment can have finished at, no earlier than the merge. |
| Master verification | `graphyard master verify-deployment GY-N`, which records the release it observed serving the delivered merge against the delivery, in the append-only ledger the pulse reads. | The repository-clock instant the verification was recorded. The release was already serving then, so this *merge → production* duration is an upper bound on the real one. |

`POST /api/deployments` ([recording deployment-provider observations](protocol/deployment-observations.md)) records deployments for [flow analytics](#flow-analytics) — frequency, latency, failure and rollback — and does **not** feed this metric. `GET /api/status` reports `production.provider`, the provider the control plane itself [watches](deployment.md#production-deployment-observation) for the base branch; that watch raises deployment incidents and does not feed this metric either.

### Not configured versus sparse

The page tells two empty states apart, because they call for different actions.

- **Production endpoint not configured.** No deployment-provider observation has ever been recorded and no delivery in the window carries a verification. The metric has no inputs, so no delivery can be measured until one of the two sources above exists; waiting for more deliveries changes nothing. `GET /api/shipping-pulse` reports `prToProduction.configured: false` with the same explanation in `unconfiguredReason`, and `prToProduction.sources` says which source is absent.
- **Sparse sample.** At least one source exists but fewer than five deliveries in the window have a production instant. The durations are real and should be read cautiously.

### Configuring the deployment provider for this deployment

This control plane runs on Railway, and Railway does not call `POST /api/production-observations` on its own. To make the metric measurable:

1. Add a `producer` principal to `GRAPHYARD_PRINCIPALS` ([deployment](deployment.md#railway)) with `"deploymentProviders": ["railway"]` and no `proofs`, then redeploy. The `producer` role alone is refused; the allowlist is the authority, and it is granted to a credential of its own rather than by widening an acceptance collector's grants.
2. Run a collector with that credential that, after each successful Railway deployment of the base branch, posts one observation naming the deployment, its finish time, the clock bracket it measured against the repository clock (within twenty seconds), the deployed commit, and every merge commit the deployment contains. The request shape and the refusals are in [Shipping pulse](shipping-pulse.md#source-and-definitions).
3. Until the collector exists, `graphyard master verify-deployment GY-N` on each delivered item gives it a production instant, and the master loop runs that step on its own.

### What each exclusion reason means

The coverage line names the single most frequent reason and its count beside the figures, so `0% coverage` is never shown without its cause; **Why records were excluded** holds the full breakdown, and `GET /api/shipping-pulse` returns the same reasons in `prToProduction.exclusions` and `prToProduction.dominantExclusion`.

| Reason | Meaning |
| --- | --- |
| `no-verifiable-production-deployment` | No successful provider observation records containment of this merge, and the master has not verified the delivery. With no observation source at all, every delivery is excluded for this reason and the page says the endpoint is not configured. |
| `superseded-deployment` | Every deployment that contained this merge was later reported `superseded`, so none of them stands as a production endpoint. |
| `production-observation-cap` | More than 100 observations matched this merge; the pulse stops at its explicit cap and marks the response partial rather than guessing which one was first. |
| `missing-pr-created-at` | The delivery observation carries no GitHub pull-request creation time, so the interval has no start. |
| `invalid-clock-order` | The pull request was created after its own merge, or the production instant precedes the merge, on the repository clock; the record is excluded rather than reported as a negative duration. |

## Flow analytics

Flow analytics opens on two things: where undelivered work is waiting, counted per wait category under the plain names the home page uses (for example "Waiting for proof that it works"; the server's category names and definitions are under **Show details**), and the time from *handed in* to *merged* (p50 and p90). The clock starts when that version of the code was handed in, so a pull request that was pushed again is measured from its last push, not from the moment it was opened.

The merge figure is computed from the phase drill-down (`GET /api/analytics/flow/drilldown?metric=phase`). It counts only merged commits whose every phase was measured. That drill-down is bounded at `flowLimits.drilldown` rows and is sorted by work key before it is cut, so one request for every phase of every episode returns the lowest-keyed items once a window holds more than about a sixth of the bound. The page never averages such a sample: when the combined request comes back `truncated`, it asks for one phase at a time, which multiplies the episodes it can read by the number of phases; and when even that is cut off it says the figure is not shown and points at the phase table under **Show details**. A category with no items is left out, and so is a figure with no data. **Show details** holds the other filters, cumulative flow, lead time, stage dwell, phase durations, operations, attribution, coverage and definitions. Attribution cards are drawn only for measured or blocked metrics; an unmeasured one is named under *Unknown, not zero* and in the attribution table.

## Hover definitions

A technical word that stays visible is shown with a dotted underline; hover it to see its meaning, and focus it too where it stands on its own (a heading, a form label, the guide). The words inside a generated sentence — "PR #42", a proof name — and inside a link, a tab or a dense row are hover-only, so a card and a dialog keep the keyboard stops they had. Every definition comes from one glossary, `web/glossary.ts`: the pull request and the commit beside it, the proof kinds the create form offers (`unit:`, `integration:`, `e2e:`, `manual:`), the words the form's own labels use (planned files, exclusive resources, review provider, CI checks, depends on), and the tab names. [Glossary](glossary.md) holds the precise definitions.

`tests/dashboard-simplification.test.ts` reads each default view as a newcomer does and fails on any abbreviation, proof name or commit that is visible without its definition in place. Where no repository is configured there is nothing to link to and the bare value is shown as it is; the item view names and defines both words in the label beside it.

## Reproducing the views

`scripts/dashboard-fixture.mjs` holds the audit fixture: ten items covering a backlog item, a lapsed claim, an unclaimed item, one being built, one in review, one proving, one blocked, and three shipped, with flow and attribution reports computed by the real aggregations. Tests import it. Running it serves the built dashboard with the fixture as its API and saves a screenshot of each view, printing each view's visible word count:

```sh
npm run build && npx tsx scripts/dashboard-fixture.mjs [OUT_DIR]
```

It never contacts a real control plane. `tests/dashboard-simplification.test.ts` renders the same views from the fixture and enforces the word budgets: 150 words for the home page, not counting item titles, and 250 words for the item view.
