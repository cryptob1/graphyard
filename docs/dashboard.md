<!-- page: Operate Graphyard | 3 | the dashboard page by page: what each number, sentence and marker means, and where everything else moved. -->
# Reading the dashboard

The dashboard answers three questions first: what is being worked on, what is stuck and why, and what shipped. Everything else is one click away. The plain-language version of this page is **How Graphyard works**, linked from the header of every dashboard page.

## Navigation

The sidebar has at most four entries.

| Entry | What it holds |
| --- | --- |
| **Work** | The home page: open items, grouped by what needs attention; **Needs you**, the requests only a human may answer; and **Workers**, every agent session across every item, as tabs. |
| **Shipped** | Every delivered item, newest first, with its pull request and whether the deployment serves it. |
| **Insights** | Shipping pulse, Flow analytics, Validation and Releases, as tabs. |
| **Settings** | Test cases, Proof authority and Operator automation, as tabs. |

A page is hidden when nothing is configured for it. An empty list and a failed read are told apart: Operator automation says the read failed and that what is configured is unknown, rather than reporting the safe bootstrap default it cannot see. Validation is hidden until a validation request exists or an item requires an `e2e:` scenario. Releases is hidden until a release or an environment exists. Operator automation is hidden until a scoped operator agent exists. Delivery slices are hidden until a slice has a lead. When the read that decides this fails, the page stays visible, so an outage never hides data. Operator automation is visible to admin sessions only. Operator-agent sessions do not see Shipping pulse or Flow analytics, because their scoped API cannot serve them.

The **Agent fleet** page is opened from the fleet line under the Work heading, or from Operator automation, the way the guide is opened from the header: it is not a tab. It shows the [agent registry](master-agent.md#the-agent-registry) — each role with its preference order, how many of its sessions are running against its concurrency limit, and the account its next action would run on; each account with its runtime, model, cost and capability, the roles it serves, its live sessions, login, quota and reset time, and, when it cannot take a session, the reason; each runtime's launch contract; and the recent selections with their reasons. Admin and coordinator sessions also get the forms that configure it — runtime, model, account, role, a quota mark, and removal — each with an audit reason; [onboarding](onboarding.md#configure-the-fleet) walks through them in order. The page names hosts and login homes, so worker, producer and operator-agent sessions do not see it.

## Needs you

**Work → Needs you** lists every open human-only request — a decision about goals and priorities, spending money or opening a third-party account, or issuing a credential to a person — longest wait first. Each card shows the item, the exact thing needed, which of the three decisions it is, who asked and why, how long it has waited, and the terminal command that answers it (`graphyard answer GY-N REQUEST ANSWER`). An item listed here holds no worker and delays nothing else.

A declared human `admin` session gets an answer box on the card. **Answer and resume** posts `work/GY-N/answer`; the item returns to the master loop, which dispatches it on its next cycle with the answer in the new worker's prompt — no master session is involved. **Decline** keeps it parked with your words as its blocker. Agent sessions see the requests but never the form, and the server refuses their answers. Recently answered requests stay listed underneath with the answer and how long it waited. On the home page a parked item reads `Stuck: Waiting on a human-only decision (…): NEEDED`.

## Workers

**Work → Workers** lists every agent session the control plane has a handle for, across every work item, in one table: worker, reviewer, producer, approver, escalation handler and master sessions alike. It is the page for "who is doing what, and how do I watch one" — the sidebar keeps its four entries, so the page is a tab of the Work section, registered beside Shipped and Insights in `web/pages/index.tsx`.

**What a row is.** A row is one [session handle](master-agent.md#session-handles): the durable record a launcher writes on the item when it starts a session, and the session itself fills in. The data comes from the handles on the work items the dashboard already polls, not from Herdr: the page never lists panes or asks a runtime anything, so it shows exactly what the control plane recorded, on every host, and nothing a launcher did not record. A row carries the agent name and principal, the role kind (worker, reviewer, producer, approver, escalation handler or master, derived from the handle's kind and role slot), the work key and attempt epoch as a link that opens the item, the subject line, the host and runtime, the recorded state, when it started, and the time spent. Time spent is live for a running handle — now minus its start, ticking once a second between polls without a reload — and fixed for a finished one, its end minus its start.

**Organised for triage.** Running sessions come first, longest time spent first. Finished sessions are collapsed below with their count, newest end first. Above both, a per-principal summary lists each worker, reviewer and producer principal once, with the item and epoch it currently holds (or *idle*), how long it has been on it, and how many of its sessions were running at any point in the last 24 hours. Approver, escalation and master sessions appear in the table but not in the summary: they belong to the loop, not to a seat that is busy or idle.

**Stale means not seen, not dead.** A handle's `updatedAt` moves when its launcher records it, when the session fills in its own tab and transcript, and when it ends. A handle recorded running whose `updatedAt` is older than the stale threshold — **15 minutes** by default, `sessionStaleThresholdMs` in `src/model/sessions.ts` — is shown as *recorded running, not seen since <updatedAt>* with a distinct amber badge, and counted in the Running heading. It is never silently shown as live. Nothing on this page ends a session: GY-113's [liveness reconciliation](master-agent.md#session-liveness-is-reconciled-not-trusted), the sweep on every automatic-dispatch tick, is what ends a dead handle, and a row it closed shows *ended by liveness reconciliation* with the rule that closed it (vanished, superseded, or the runtime's own ended state) and the recorded outcome saying why.

**Two attach forms, one click each.** Every running row offers the attach command in two forms, each copied exactly as shown, with no prose around it:

- **Copy local** — the command the handle recorded, as run on the host that launched it, for example `herdr pane attach w1V:pJD --workspace w1V`.
- **Copy remote** — the same command run from another machine through Herdr's remote machinery. The installed `herdr --help` documents `herdr --machine <label-or-id> <command>` ("Run an API command on a saved SSH machine") as the way to run a subcommand against a remote server, and `herdr --remote <target>` as attaching the whole TUI through SSH; so the remote form is the local command with the handle's recorded host as the machine selector: `herdr --machine vishrog pane attach w1V:pJD --workspace w1V`. The selector must be a saved Herdr machine profile whose label is the host name the handle records (`herdr machine list` shows them). A recorded command that is not Herdr's has no remote form, and the row says so.

A finished row offers its transcript path instead, since there is nothing left to attach to; a row with neither says so rather than offering a command that cannot work.

The derivation — stale, the two forms, the order and the per-principal summary — is `workersView` in `src/model/sessions.ts`, and `tests/workers-tab.test.ts` renders the page over a fixture and asserts each of them.

## The status sentence

Every card, and the top of every item view, carries one sentence derived from the item's first refusing gate. It says what is happening, what happens next and who is on it, for example *Waiting for someone to pick this up*, *Alex is building it — no pull request yet*, *Waiting for review of PR #42* or *Stuck: needs a second Postgres instance*. The mapping from gate reasons to sentences lives in `web/plain-status.ts`. A reason it does not recognise reads as its step, for example *Waiting to merge*, and never as raw internal text.

**Stuck** means the item will not move until someone decides or fixes something: a recorded blocker, a standing escalation or lead hold, a merge conflict, a pull request that changes files outside its plan, no available reviewer, or a proof that no longer counts. Everything else is waiting its turn.

## The home page

The page counts open work in one place. Nothing is counted twice — not on the page, not beside it in the sidebar, and not in board view — and no total that is a sum of the row is drawn as its own tile.

- **The heading** carries the open total: *Work 7* is seven items not shipped yet. It is the sum of the count row, so it appears nowhere else: the sidebar's *Work* entry is a name, not a count.
- **The count row** is the one row of counts: the stages, in work order, each with its open items. A stage holding nothing is drawn not at all — no label, no zero, no placeholder — so the row is only as wide as there is work, and the whole row is absent when nothing is open. An item whose claim lapsed is under *Needs a worker*, not *Being built*, whatever its stored stage says. Click a stage to filter the lists to it, click it again to clear. *Show times* adds the oldest item and the p50/p95 time in each drawn stage. Delivered work is never in the row.
- **Lists** show *Stuck* first, then *In progress* and *Needs a worker*, oldest first within each; *Not started* is collapsed. Only *Stuck* carries a count, highlighted — it is the one count for work needing attention, and it counts items, not gate reasons. The other headings name a group the row already counts, so they repeat no number.
- **Board view** draws a column for every open stage, empty ones included, because a board is read as a fixed set of columns and a missing one would read as a stage that no longer exists. A column is headed by its stage name alone: the count row above it already says how many, so no column repeats the number.
- **Shipped this week** lists items merged in the last seven days and links to Shipped.

The numbers come from one function, `homeNumbers` in `web/home-numbers.ts`, and `unit:home-numbers-reconcile` asserts that they agree. It returns one field per number drawn — the row, the open total, the stuck count and the week's shipped count — and no per-stage alias beside the row. `unit:work-page-single-count-row` and `unit:work-page-no-derived-totals` hold the page to one count row and one home for each number; `integration:work-page-density` holds empty stages out of the default view.

## The item view

The item view opens with the status sentence, the owner, the pull request and the single thing blocking progress. **Steps** lists the gates in order: passed steps get one line each, the current step shows its reasons in plain words, and later steps are collapsed. **What must be true** lists each acceptance criterion once, with one marker per proof: ✓ passed, ○ pending (or put off), × failed or withdrawn.

**More details** holds everything else: the description, type, priority, policy and revision, worker ID and assignment, workspaces, coordination diagnosis, file overlaps, merge-queue position, review provider, the raw gate reasons, proof details, bootstrap obligations, observed delivery, evidence with its artifacts, and history. Admin sessions get an **Edit** menu for actions that change the item's rules: switching the review provider, requesting a fresh provider review, and revising requirements.

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
