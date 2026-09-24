<!-- page: Operate Graphyard | 3 | what each page and marker means. -->
# Reading the dashboard

## Navigation

- **Work**: open items grouped by what needs attention; **Needs you**, everything only you may answer; and **Workers**, every agent session across every item, as tabs. The **Agent fleet** page edits the [agent registry](onboarding.md#configure-the-fleet).
- **Shipped**: delivered items and **Interventions**.
- **Insights**: Shipping pulse, Flow analytics, Validation and Releases.
- **Settings**: Test cases, Proof authority and Operator automation.

**Needs you** lists every action only your credential may take: a parked human-only decision (**Answer and resume**) or an approval no agent may give (**Approve and deliver**).

## Workers

**Work → Workers** is a tab of the Work section, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-reference.md#running-executors-under-supervision), the record a launcher writes on the item; the data comes from polled work items, not from Herdr.

A handle recorded running whose `updatedAt` is older than **15 minutes** by default, `sessionStaleThresholdMs` in `web/workers-view.ts`, reads *recorded running, not seen since <updatedAt>*, never as live; GY-113's [liveness reconciliation](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Each running row offers two commands:

- **Copy local**, on the launching host: `herdr agent attach w1V:pJD`, built from the recorded pane.
- **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`, and interactive attachment is not forwarded by `--machine`, so the form focuses the pane then attaches remotely: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## The status sentence

Every card carries one sentence from the item's first refusing gate (*Waiting for review of PR #42*), mapped in `web/plain-status.ts`. **Stuck** means nothing moves until someone decides or fixes something. The card also shows how long the item has held its current status; past thirty minutes it reads `1h 12m overdue`. Each criterion's proofs show ✓ passed, ○ pending or × failed.

## Insights

**Shipping pulse** measures PR-to-production time from provider observations (`POST /api/production-observations`) or `master verify-deployment`. **Flow analytics** shows where work waits. **Interventions** counts each time someone stepped in; with `GRAPHYARD_INTERVENTION_PATTERNS=1`, a repeated pattern opens a `bug` item. Missing values read `Unavailable`, never zero.
