<!-- page: Operate Graphyard | 3 | what each page and marker means. -->
# Reading the dashboard

## Navigation

One sidebar: **Work**, **Workers**, **Shipped**, **Tests** (planned, GY-162), **Insights**, **Settings**.

## Work: one classification

Each open item is in one group: **Needs you** (only you may decide), **Blocked**, **Moving**, **Up next** or **Backlog**. A tile counts and filters one group.

`GET /api/board` (`src/model/board.ts`) serves these groups, not the page. Items carry `group`, `stage`, `owner`, `actor` (`worker`, `reviewer`, `producer`, `approver`, `master`, `executor` or `human-only`), `command` (or null), `since` and `overdue` (past `overdueAfterMs`). `master status` lists the master's items as `board.owed`.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), from the item, not from Herdr.

A running handle last observed (`observedAt`, else `updatedAt`) over **15 minutes** by default, `sessionStaleThresholdMs` in `web/workers-view.ts`, reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Running rows offer:

- **Copy local**, on the launching host: `herdr agent attach w1V:pJD`.
- **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`, and interactive attachment is not forwarded by `--machine`, so the form focuses the pane then attaches remotely: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

A live [research run](master-agent.md#research-before-build) is its own row: role **Researches**, the model it runs on, its item and since when. It holds no session handle, so it is read from the item's research record and ends when the brief or the failure is recorded.

## The status sentence

Rows show the steps **Research, Build, Validate, Test, Review, Prove, Merge, Deploy** (`web/pr-steps.ts`). Research is *Researching* while its run is live or awaited (the item is Moving, the Research agent acts next), done once the brief is recorded, and **skipped** (a hatched segment, never missing or failed) for a bug, `"research": false`, research not configured, or a run that ended without a brief. A merged item reads *Merged*, then *Live* once production serves it (counted this week). Moving and Blocked rows past thirty minutes read `1h 12m overdue`.

## An item page

Below the summary: **What is left** (unmet requirements and who clears each), **Requirements** (✓ or ○ per criterion), **Pull request** and **Activity**. **Research brief**, collapsed by default, shows the brief the build started from — approach, existing code (paths), patterns, risks and the product questions with their answer or recommendation — and on its summary line the run's model, duration and token spend. **Technical details** holds gates, sessions, evidence and overlaps (`Shares files with GY-166, GY-167 (tests/)`).

## Insights

Headline numbers, **Flow** replay (research to live, one column per step), landed per day (each day's hover names how many were built from a research brief), where time goes (Research is a step with its own median), and **Research**: runs, briefs, runs without a brief, median run time, and rework rounds and review findings per feature for researched against unresearched features over the window. Flow analytics' step dwell, step moves and *where work is waiting* (`Researching`) include research; **Show details** holds shipping pulse (PR-to-production from `POST /api/production-observations` or `master verify-deployment`) and flow analytics. **Shipped** holds **Interventions**, **Validation** and **Releases**; `GRAPHYARD_INTERVENTION_PATTERNS=1` files repeats as `bug` items. Missing values read `Unavailable`, never zero.
