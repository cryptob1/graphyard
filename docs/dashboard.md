<!-- page: Operate Graphyard | 3 | the dashboard page by page: what each number, sentence and marker means, and where everything else moved. -->
# Reading the dashboard

The dashboard answers three questions first: what is being worked on, what is stuck and why, and what shipped. **How Graphyard works**, linked from every page header, is the plain-language version of this page.

## Navigation

| Entry | What it holds |
| --- | --- |
| **Work** | Open items grouped by what needs attention; **Needs you**, everything only you may answer; and **Workers**, every agent session across every item, as tabs. |
| **Shipped** | Every delivered item, newest first, with its pull request and whether the deployment serves it. |
| **Insights** | Shipping pulse, Flow analytics, Validation and Releases, as tabs. |
| **Settings** | Test cases, Proof authority and Operator automation, as tabs. |

Unconfigured pages are hidden. The **Agent fleet** page, opened from the fleet line under the Work heading, shows the [agent registry](master-agent.md#the-agent-registry): roles, accounts, runtimes, quota, and why an account cannot launch; admin and coordinator sessions can edit it ([onboarding](onboarding.md#configure-the-fleet)).

## Needs you

**Work → Needs you** lists every action only your own credential may take, longest wait first, each with the equivalent terminal command for the record:

- **A human-only decision** (goals and priorities, spending money or opening an account, issuing a credential to a person). The worker parks the item with `graphyard park`. **Answer and resume** posts `work/GY-N/answer` and the loop redispatches with your answer; **Decline** keeps it parked.
- **An approval no agent may give**, such as a merge decision overriding a refused reconciliation. **Approve and deliver** posts `work/GY-N/approve`.

The list is derived from the human-only rules in `src/model/human-request.ts` (`GET /api/human-requests`).

## Workers

**Work → Workers** lists every agent session with a handle, across every item: worker, reviewer, producer, approver, escalation handler and master. It is a tab of the Work section, registered beside Shipped and Insights in `web/pages/index.tsx`.

A row is one [session handle](master-agent.md#session-handles), the record a launcher writes on the item. The data comes from the handles on polled work items, not from Herdr. Running sessions come first, longest first; finished ones are collapsed. A per-principal summary shows what each principal holds.

A handle recorded running whose `updatedAt` is older than **15 minutes** by default, `sessionStaleThresholdMs` in `web/workers-view.ts`, reads *recorded running, not seen since <updatedAt>* with an amber badge, never as live. Nothing here ends a session: GY-113's [liveness reconciliation](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Each running row offers two commands, copied exactly:

- **Copy local**, on the launching host: `herdr agent attach w1V:pJD`, built from the recorded pane (launchers record `herdr pane attach …`, which Herdr 0.9.1 lacks). A command that is not Herdr's is copied as recorded.
- **Copy remote**, from another machine. `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`, and interactive attachment is not forwarded by `--machine`, so the form focuses the pane then attaches remotely: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`. The recorded host must be a saved Herdr machine label and an SSH target.

A finished row offers its transcript path instead. The logic is `workersView` in `web/workers-view.ts`, tested by `tests/workers-tab.test.ts`.

## The status sentence

Every card and item view carries one sentence derived from the item's first refusing gate — *Waiting for review of PR #42*, *Stuck: needs a second Postgres instance* — mapped in `web/plain-status.ts`. **Stuck** means nothing moves until someone decides or fixes something: a blocker, escalation, lead hold, merge conflict, out-of-plan files, no reviewer, or a proof that no longer counts.

## How long it has held its status

Every card shows **how long the item has held its current status**, not its age. Past thirty minutes (`OVERDUE_MINUTES` in `web/duration.ts`) it turns red and reads `1h 12m overdue`. Heartbeats and retries do not reset the clock.

## The home page

- **The heading** carries the open total (*Work 7*), the sum of the count row.
- **The count row** shows each non-empty stage with its open items; click to filter. A lapsed claim counts under *Needs a worker*. *Show times* adds oldest and p50/p95.
- **Lists** show *Stuck* first (the only counted heading), then *In progress* and *Needs a worker*; *Not started* is collapsed.
- **Board view** draws every open stage as a column.
- **Shipped this week** lists merges from the last seven days.

All numbers come from `homeNumbers` in `web/home-numbers.ts`.

## The item view

Key and held duration, status sentence, owner, pull request and the one blocker. **Steps** lists the gates in order. **What must be true** lists each criterion with one marker per proof: ✓ passed, ○ pending, × failed or withdrawn. **More details** holds everything else; admins get an **Edit** menu for review provider and requirement revisions.

## Shipping pulse

**Insights → Shipping pulse** shows merges per week, intent-to-merge and the pull-request-to-production split: PR created → merge → first production instant, as average, median and p90 with a coverage line. Empty figures read `Unavailable`, never zero. Definitions are in [Shipping pulse](shipping-pulse.md).

A production instant comes from a deployment-provider observation (`POST /api/production-observations` by a `producer` whose `deploymentProviders` names the provider; for Railway add one to `GRAPHYARD_PRINCIPALS` per [deployment](deployment.md#railway-by-hand) and run a collector), or else from `graphyard master verify-deployment GY-N`. **Production endpoint not configured** means neither source exists; exclusion reasons are in `prToProduction.exclusions`. `POST /api/deployments` feeds [flow analytics](#flow-analytics), not this metric.

## Flow analytics

Opens on where undelivered work is waiting and p50/p90 from *handed in* (last push) to *merged*; it never averages a truncated sample. **Show details** holds cumulative flow, lead time, dwell, phases and attribution.

## Hover definitions

Technical words carry a dotted underline with a definition from `web/glossary.ts`. `tests/dashboard-simplification.test.ts` fails on any visible abbreviation or proof name without one, and enforces word budgets (150 for the home page, 250 for the item view).

## Reproducing the views

```sh
npm run build && npx tsx scripts/dashboard-fixture.mjs [OUT_DIR]
```

serves the built dashboard over a ten-item fixture, saves a screenshot of each view and prints word counts. It never contacts a real control plane.
