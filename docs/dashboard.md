<!-- page: Operate Graphyard | 3 | the dashboard page by page: what each number, sentence and marker means, and where everything else moved. -->
# Reading the dashboard

The dashboard answers three questions first: what is being worked on, what is stuck and why, and what shipped. Everything else is one click away. The plain-language version of this page is **How Graphyard works**, linked from the header of every dashboard page.

## Navigation

The sidebar has at most four entries.

| Entry | What it holds |
| --- | --- |
| **Work** | The home page: open items, grouped by what needs attention. |
| **Shipped** | Every delivered item, newest first, with its pull request and whether the deployment serves it. |
| **Insights** | Shipping pulse, Flow analytics, Validation and Releases, as tabs. |
| **Settings** | Test cases, Proof authority and Operator automation, as tabs. |

A page is hidden when nothing is configured for it. Validation is hidden until a validation request exists or an item requires an `e2e:` scenario. Releases is hidden until a release or an environment exists. Operator automation is hidden until a scoped operator agent exists. Delivery slices are hidden until a slice has a lead. When the read that decides this fails, the page stays visible, so an outage never hides data. Operator automation is visible to admin sessions only. Operator-agent sessions do not see Shipping pulse or Flow analytics, because their scoped API cannot serve them.

## The status sentence

Every card, and the top of every item view, carries one sentence derived from the item's first refusing gate. It says what is happening, what happens next and who is on it, for example *Waiting for someone to pick this up*, *Alex is building it — no pull request yet*, *Waiting for review of PR #42* or *Stuck: needs a second Postgres instance*. The mapping from gate reasons to sentences lives in `web/plain-status.ts`. A reason it does not recognise reads as its step, for example *Waiting to merge*, and never as raw internal text.

**Stuck** means the item will not move until someone decides or fixes something: a recorded blocker, a standing escalation or lead hold, a merge conflict, a pull request that changes files outside its plan, no available reviewer, or a proof that no longer counts. Everything else is waiting its turn.

## The home page

- **Tiles** count open items only: *Open*, *Being built*, *Need a worker* and *Stuck*. Delivered work is never in a tile. *Stuck* counts items, not gate reasons.
- **The stage strip** splits the open items by stage. Its counts add up to *Open*. An item whose claim lapsed is under *Needs a worker*, not *Being built*, whatever its stored stage says. *Show times* adds the oldest item and the p50/p95 time in each stage.
- **Lists** show *Stuck* first, then *In progress* and *Needs a worker*, oldest first within each. *Not started* is collapsed. *Board view* arranges the same items in stage columns.
- **Shipped this week** lists items merged in the last seven days and links to Shipped.

The numbers come from one function, `homeNumbers` in `web/home-numbers.ts`, and `unit:home-numbers-reconcile` asserts that they agree.

## The item view

The item view opens with the status sentence, the owner, the pull request and the single thing blocking progress. **Steps** lists the gates in order: passed steps get one line each, the current step shows its reasons in plain words, and later steps are collapsed. **What must be true** lists each acceptance criterion once, with one marker per proof: ✓ passed, ○ pending (or put off), × failed or withdrawn.

**More details** holds everything else: the description, type, priority, policy and revision, worker ID and assignment, workspaces, coordination diagnosis, file overlaps, merge-queue position, review provider, the raw gate reasons, proof details, bootstrap obligations, observed delivery, evidence with its artifacts, and history. Admin sessions get an **Edit** menu for actions that change the item's rules: switching the review provider, requesting a fresh provider review, and revising requirements.

## Flow analytics

Flow analytics opens on two things: where undelivered work is waiting, counted per wait category, and the time from pull request opened to merged (p50 and p90). The merge figure is computed from the phase drill-down (`GET /api/analytics/flow/drilldown?metric=phase`). It counts only merged commits whose every phase was measured. A category with no items is left out, and so is a figure with no data. **Show details** holds the other filters, cumulative flow, lead time, stage dwell, phase durations, operations, attribution, coverage and definitions. Attribution cards are drawn only for measured or blocked metrics; an unmeasured one is named under *Unknown, not zero* and in the attribution table.

## Hover definitions

A technical word that stays visible is shown with a dotted underline; hover or focus it to see its meaning. Every definition comes from one glossary, `web/glossary.ts`. [Glossary](glossary.md) holds the precise definitions.

## Reproducing the views

`scripts/dashboard-fixture.mjs` holds the audit fixture: ten items covering a backlog item, a lapsed claim, an unclaimed item, one being built, one in review, one proving, one blocked, and three shipped, with flow and attribution reports computed by the real aggregations. Tests import it. Running it serves the built dashboard with the fixture as its API and saves a screenshot of each view, printing each view's visible word count:

```sh
npm run build && npx tsx scripts/dashboard-fixture.mjs [OUT_DIR]
```

It never contacts a real control plane. `tests/dashboard-simplification.test.ts` renders the same views from the fixture and enforces the word budgets: 150 words for the home page, not counting item titles, and 250 words for the item view.
