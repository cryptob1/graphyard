<!-- page: Operate Graphyard | 3 | what each number, sentence and marker means. -->
# Reading the dashboard

The dashboard answers what is being worked on, what is stuck and why, and what shipped. **How Graphyard works**, linked from every page header, is the plain-language version.

## Navigation

| Entry | What it holds |
| --- | --- |
| **Work** | Open items grouped by what needs attention; **Needs you**, everything only you may answer; and **Workers**, every agent session across every item, as tabs. |
| **Shipped** | Every delivered item, newest first, with its pull request and whether the deployment serves it. |
| **Insights** | Shipping pulse, Flow analytics, Validation and Releases, as tabs. |
| **Settings** | Test cases, Proof authority and Operator automation, as tabs. |

Unconfigured pages are hidden. The **Agent fleet** page (the fleet line under the Work heading) shows the [agent registry](master-agent-sessions.md#the-agent-registry): roles, accounts, runtimes, quota, and why an account cannot launch; admin and coordinator sessions edit it ([onboarding](onboarding.md#configure-the-fleet)).

## Needs you

**Work → Needs you** lists every action only your credential may take, longest wait first, each with its terminal command:

- **A human-only decision** (goals and priorities, spending money or opening an account, issuing a credential to a person). The worker parks it with `graphyard park`. **Answer and resume** posts `work/GY-N/answer` and the loop redispatches; **Decline** keeps it parked.
- **An approval no agent may give**, such as a merge decision overriding a refused reconciliation. **Approve and deliver** posts `work/GY-N/approve`.

The list is derived from the human-only rules in `src/model/human-request.ts` (`GET /api/human-requests`).

## Workers

**Work → Workers** lists every agent session with a handle, across every item: worker, reviewer, producer, approver, escalation handler and master. It is a tab of the Work section, registered beside Shipped and Insights in `web/pages/index.tsx`.

A row is one [session handle](master-agent-reference.md#session-handles), the record a launcher writes on the item; the data comes from polled work items, not from Herdr. Running sessions come first, longest first; finished ones collapse. A per-principal summary shows what each holds.

A handle recorded running whose `updatedAt` is older than **15 minutes** by default, `sessionStaleThresholdMs` in `web/workers-view.ts`, reads *recorded running, not seen since <updatedAt>* with an amber badge, never as live. Nothing here ends a session: GY-113's [liveness reconciliation](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Each running row offers two commands, copied exactly:

- **Copy local**, on the launching host: `herdr agent attach w1V:pJD`, built from the recorded pane (launchers record `herdr pane attach …`, which Herdr 0.9.1 lacks). A command that is not Herdr's is copied as recorded.
- **Copy remote**, from another machine. `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`, and interactive attachment is not forwarded by `--machine`, so the form focuses the pane then attaches remotely: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`. The recorded host must be a saved Herdr machine label and an SSH target.

A finished row offers its transcript path instead (`workersView` in `web/workers-view.ts`).

## The status sentence

Every card and item view carries one sentence from the item's first refusing gate (*Waiting for review of PR #42*, *Stuck: needs a second Postgres instance*), mapped in `web/plain-status.ts`. **Stuck** means nothing moves until someone decides or fixes something: a blocker, escalation, lead hold, merge conflict, out-of-plan files, no reviewer, or a proof that no longer counts.

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

**Insights → Shipping pulse** shows merges per week, intent-to-merge and PR created → merge → first production instant (average, median, p90, coverage). Empty figures read `Unavailable`, never zero ([definitions](shipping-pulse.md)).

A production instant comes from a deployment-provider observation (`POST /api/production-observations` by a `producer` whose `deploymentProviders` names the provider; for Railway add one to `GRAPHYARD_PRINCIPALS` per [deployment](deployment.md#railway-by-hand) and run a collector), or else from `graphyard master verify-deployment GY-N`. **Production endpoint not configured** means neither source exists; exclusion reasons are in `prToProduction.exclusions`. `POST /api/deployments` feeds [flow analytics](#flow-analytics), not this metric.

## Flow analytics

Opens on where undelivered work waits and p50/p90 from *handed in* (last push) to *merged*, never averaging a truncated sample; **Show details** holds the rest.

## Hover definitions

Technical words carry a dotted underline defined in `web/glossary.ts`; `tests/dashboard-simplification.test.ts` fails on an undefined abbreviation or proof name and enforces word budgets (150 home, 250 item view).

## Reproducing the views

```sh
npm run build && npx tsx scripts/dashboard-fixture.mjs [OUT_DIR]
```

serves the built dashboard over a ten-item fixture, screenshots each view and prints word counts, never contacting a real control plane.
