<!-- page: Operate Graphyard | 3 | pages. -->
# Reading the dashboard

Sidebar: **Work**, **Workers**, **Shipped**, **Tests**, **Insights**, **Settings**.

## Work

One group per open item (a tile counts and filters it): **Needs you** (yours alone), **Blocked**, **Moving**, **Up next**, **Backlog**. `GET /api/board` serves groups, not the page; items carry `group`, `stage`, `owner`, `actor`, `command`, `since`, `overdue` (Moving/Blocked past `overdueAfterMs`, default 30 minutes). `master status` lists the master's as `board.owed`.

## Needs you

`graphyard login` prints the operator's single-use, ten-minute sign-in link; others get **Sign in as the operator**. Requests offer choice buttons and notes; **Provide now** seals credentials for `unseal GY-N`; a refused answer keeps the form.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), from the item, not from Herdr. A running handle last observed over **15 minutes** by default, `sessionStaleThresholdMs` (`web/workers-view.ts`), reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Running rows: **Copy local** (launching host) `herdr agent attach w1V:pJD`; **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`; interactive attachment is not forwarded, so focus, then attach: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## Settings › Agents

**Can launch now?**: per role, yes, or why not and until when. **Accounts**: first applicable chip (Disabled, No role, Spent, Launch failing: failed smoke test, role hold or start failure within the hour; Unavailable, Working, Idle). **Account details**: **old probe** past an hour; **probe failed** after a failed smoke test. Operator identity ids sit behind **Identifiers**.

## The status sentence

Rows: **Build, Validate, Test, Review, Prove, Merge, Deploy**, then *Merged*, *Live* once served.

## An item page

Below the summary: **What is left**; **Requirements** (✓/○); **Pull request** with **Merge danger** (low/medium/high); **Test cases**; **Activity**; **Technical details** (gates, sessions, evidence, overlaps).

## Insights

**Flow**, landed/day, merges/hour, median wait, time spent, [optimistic merges](github.md#optimistic-merges). **Show details**: shipping pulse (`POST /api/production-observations` or `master verify-deployment`), flow analytics. **Shipped**: **Interventions** ([retro](operations-reference.md#retro-synthesis); `GRAPHYARD_INTERVENTION_PATTERNS=1` files repeats as `bug` items), **Validation**, **Releases**.
