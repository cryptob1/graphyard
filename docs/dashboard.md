<!-- page: Operate Graphyard | 3 | pages and markers. -->
# Reading the dashboard

## Navigation

One sidebar: **Work**, **Workers**, **Shipped**, **Tests** (planned), **Insights**, **Settings**.

## Work: one classification

Each open item is in one group: **Needs you** (only you may decide), **Blocked**, **Moving**, **Up next** or **Backlog**; a tile counts and filters one.

`GET /api/board` (`src/model/board.ts`) serves these groups, not the page. Items carry `group`, `stage`, `owner`, `actor` (`worker`, `reviewer`, `producer`, `approver`, `master`, `executor`, `human-only`, `held`), `command` (or null), `since` and `overdue` (past `overdueAfterMs`). `master status` lists the master's items as `board.owed`.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), from the item, not from Herdr.

A running handle last observed (`observedAt`, else `updatedAt`) over **15 minutes** by default, `sessionStaleThresholdMs` in `web/workers-view.ts`, reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Running rows offer:

- **Copy local**, on the launching host: `herdr agent attach w1V:pJD`.
- **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`, and interactive attachment is not forwarded by `--machine`, so the form focuses the pane then attaches remotely: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## Watching a session live

**Watch live**, in an item's **Sessions** panel and under **Live sessions** on **Workers**, opens a read-only view (`web/session-viewer.tsx`) of any running session the loop launched: worker, reviewer, producer, approver, doctor or research. Each row names its role, runtime, account, state and age; the view follows the last 200 lines and shows the transcript path and the Herdr attach command. The launching host's loop publishes the tail, redacted like evidence, every 3 s while watched and every 30 s otherwise; Herdr panes are read through Herdr and headless runs from their log under `.graphyard/runs`. Nothing typed reaches a session: attach locally to act.

`run.approver.surface`, `run.producer.surface` and `run.research.surface` in `.graphyard/master.json` take `headless` (default) or `herdr`, which runs that role inside a Herdr pane; the view works either way.

## The status sentence

Rows show **Build, Validate, Test, Review, Prove, Merge, Deploy** (`src/model/pr-steps.ts`). A merged item reads *Merged*, then *Live* once production serves it (counted this week). Moving and Blocked rows past thirty minutes read `1h 12m overdue`.

## An item page

Below the summary: **What is left** (unmet requirements, who clears each), **Requirements** (✓ or ○ per criterion), **Pull request** and **Activity**. **Technical details** holds gates, sessions, evidence and overlaps (`Shares files with GY-166, GY-167 (tests/)`).

## Insights

Headline numbers, **Flow** replay, landed per day, time spent; **Show details** holds shipping pulse (PR-to-production from `POST /api/production-observations` or `master verify-deployment`) and flow analytics. **Shipped** holds **Interventions**, **Validation** and **Releases**; `GRAPHYARD_INTERVENTION_PATTERNS=1` files repeats as `bug` items. Missing values read `Unavailable`, never zero.
