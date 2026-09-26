<!-- page: Operate Graphyard | 3 | what each page and marker means. -->
# Reading the dashboard

## Navigation

One sidebar: **Work**, **Workers**, **Shipped**, **Tests** (planned), **Insights**, **Settings**.

## Work: one classification

Each open item is in one group: **Needs you** (only you may decide), **Blocked**, **Moving**, **Up next** or **Backlog**.

`GET /api/board` (`src/model/board.ts`) serves these groups, not the page. Items carry `group`, `stage`, `owner`, `actor` (the role acting next), `command`, `since` and `overdue` (past `overdueAfterMs`). `master status` lists the master's items as `board.owed`.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), from the item, not from Herdr.

A running handle last observed (`observedAt`, else `updatedAt`) over **15 minutes** by default, `sessionStaleThresholdMs`, reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Running rows offer:

- **Copy local** (launching host): `herdr agent attach w1V:pJD`.
- **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`; interactive attachment is not forwarded by `--machine`, so: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## The status sentence

Rows show the steps **Build, Validate, Test, Review, Prove, Merge, Deploy** (`web/pr-steps.ts`). A merged item reads *Merged*, then *Live* once production serves it. Moving and Blocked rows past thirty minutes read `1h 12m overdue`.

## An item page

Below the summary: **What is left** (unmet requirements and who clears each), **Requirements** (✓ or ○ per criterion), **Pull request** and **Activity**. **Technical details** holds gates, sessions, evidence and overlaps.

## Insights

Headline numbers, **Flow** replay, landed per day, where time goes, [optimistic merges](github.md#optimistic-merges); **Show details** holds shipping pulse (PR-to-production from `POST /api/production-observations` or `master verify-deployment`) and flow analytics. **Shipped** holds **Interventions**, **Validation** and **Releases**; `GRAPHYARD_INTERVENTION_PATTERNS=1` files repeats as `bug` items. Missing values read `Unavailable`, never zero.
