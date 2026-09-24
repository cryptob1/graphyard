<!-- page: Operate Graphyard | 3 | what each page and marker means. -->
# Reading the dashboard

## Navigation

One sidebar: **Work**, **Workers**, **Shipped**, **Tests** (planned, GY-162), **Insights** and **Settings**; a section's other pages are listed above its content. Colours and fonts are the tokens atop `web/style.css`, per `design/dashboard/`.

## Work: one classification

Each open item is in one group (`web/groups.ts`): **Needs you** (only you may decide; answered on the item page), **Blocked**, **Moving**, **Up next** or **Backlog**. A tile counts one group and filters to its rows. Only Moving and Blocked rows carry a clock.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), the record a launcher writes on the item; the data comes from polled work items, not from Herdr.

A handle recorded running whose `updatedAt` is older than **15 minutes** by default, `sessionStaleThresholdMs` in `web/workers-view.ts`, reads *recorded running, not seen since <updatedAt>*, never as live; GY-113's [liveness reconciliation](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Each running row offers two commands:

- **Copy local**, on the launching host: `herdr agent attach w1V:pJD`, built from the recorded pane.
- **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`, and interactive attachment is not forwarded by `--machine`, so the form focuses the pane then attaches remotely: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## The status sentence

Moving rows show the steps **Build, Validate, Test, Review, Prove, Merge, Deploy** from the gates (`web/pr-steps.ts`), the current one in plain words, and who acts next. An item page's first screen gives its state, why, who acts next and its pull request; the rest is under **More details**. Past thirty minutes a step reads `1h 12m overdue`.

## Insights

**Flow** shows each item at its step now and replays the last day's recorded step changes. **Shipping pulse** measures PR-to-production time from provider observations (`POST /api/production-observations`) or `master verify-deployment`. **Flow analytics** shows where work waits. **Interventions** counts each time someone stepped in; with `GRAPHYARD_INTERVENTION_PATTERNS=1`, a repeated pattern opens a `bug` item. Missing values read `Unavailable`, never zero.
