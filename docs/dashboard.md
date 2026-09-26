<!-- page: Operate Graphyard | 3 | pages and markers. -->
# Reading the dashboard

## Navigation

One sidebar: **Work**, **Workers**, **Shipped**, **Tests** (planned), **Insights**, **Settings**.

## Work: one classification

Each open item is in one group: **Needs you** (only you may decide), **Blocked**, **Moving**, **Up next** or **Backlog**; a tile counts and filters one.

`GET /api/board` (`src/model/board.ts`) serves these groups, not the page. Items carry `group`, `stage`, `owner`, `actor` (`worker`, `reviewer`, `producer`, `approver`, `master`, `executor`, `human-only`, `held`), `command` (or null), `since` and `overdue` (past `overdueAfterMs`). `master status` lists the master's items as `board.owed`.

## Workers

**Workers** (`web/pages/index.tsx`): a row is one [session handle](master-agent-sessions.md#session-handles), from the item, not from Herdr.

A running handle last observed (`observedAt`, else `updatedAt`) over **15 minutes** by default, `sessionStaleThresholdMs` in `web/workers-view.ts`, reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Running rows offer:

- **Copy local**, on the launching host: `herdr agent attach w1V:pJD`.
- **Copy remote**: `--machine` does not forward interactive attachment, so it focuses the pane then attaches remotely: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## The status sentence

Rows show **Build, Validate, Test, Review, Prove, Merge, Deploy**. A merged item reads *Merged*, then *Live* once production serves it (counted this week). Moving and Blocked rows past thirty minutes read `1h 12m overdue`.

## An item page

Below the summary: **What is left** (unmet requirements, who clears each), **Requirements** (✓ or ○ per criterion), **Pull request** and **Activity**. **Technical details** holds gates, sessions, evidence and overlaps (`Shares files with GY-166, GY-167 (tests/)`).

## Insights

Headline numbers, **Flow** (Now columns show 12 dots, then **+N more**; medians survive a failed replay read), landed per day, time spent; **Show details** holds shipping pulse (PR-to-production from `POST /api/production-observations` or `master verify-deployment`) and flow analytics. **Shipped** holds **Interventions**, **Validation** and **Releases**; `GRAPHYARD_INTERVENTION_PATTERNS=1` files repeats as `bug` items. Missing values read `Unavailable`.
