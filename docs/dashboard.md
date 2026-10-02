<!-- page: Operate Graphyard | 3 | pages and markers. -->
# Reading the dashboard

Sidebar: **Work**, **Workers**, **Shipped**, **Tests**, **Insights**, **Settings**.

## Work

One group per open item (a tile counts and filters it): **Needs you** (yours alone), **Blocked**, **Moving**, **Up next**, **Backlog**. `GET /api/board` serves groups, not the page; items carry `group`, `stage`, `owner`, `actor` (`worker`, `reviewer`, `producer`, `approver`, `master`, `executor`, `human-only`, `held`), `command` (or null), `since`, `overdue` (Moving/Blocked past `overdueAfterMs`, default 30 minutes). `master status`: the master's as `board.owed`.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), from the item, not from Herdr. A running handle last observed over **15 minutes** by default, `sessionStaleThresholdMs` (`web/workers-view.ts`), reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Running rows: **Copy local** (launching host) `herdr agent attach w1V:pJD`; **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`; interactive attachment is not forwarded, so focus, then attach: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## Settings › Agents

**Can launch now?**: per role, yes, or why not and until when. **Accounts**: first applicable chip (Disabled, No role, Spent, Launch failing: failed smoke test, role hold or start failure within the hour; Unavailable, Working, Idle); local times, countdowns (`web/agent-status.ts`). **Account details**: **old probe** past an hour (`quotaStaleThresholdMs`, `web/pages/fleet.tsx`); **probe failed** after a failed smoke test. Settings pages share `web/components/page-layout.tsx`; operator identity ids behind **Identifiers**.

## The status sentence

Rows: **Build, Validate, Test, Review, Prove, Merge, Deploy**, then *Merged*, *Live* once production serves it (counted this week).

## An item page

Below the summary: **What is left**; **Requirements** (✓/○ per criterion); **Pull request** with **Merge danger** (low/medium/high; one- or two-way door: what it touches, what a revert restores, what the merge guard still checks; schema, deployment, workflow files one-way); **Test cases**; **Activity**; **Technical details** (gates, sessions, evidence, overlaps: `Shares files with GY-166, GY-167 (tests/)`).

## Insights

Headline numbers, **Flow** (12 dots per column, then **+N more**; medians survive a failed replay read), landed/day, merges/hour, median queue wait, time spent, [optimistic merges](github.md#optimistic-merges). **Show details**: shipping pulse (PR-to-production via `POST /api/production-observations` or `master verify-deployment`), flow analytics. **Shipped**: **Interventions** ([retro](operations-reference.md#retro-synthesis); `GRAPHYARD_INTERVENTION_PATTERNS=1` files repeats as `bug` items), **Validation**, **Releases**. Missing values: `Unavailable`.
