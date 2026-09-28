<!-- page: Operate Graphyard | 3 | pages and markers. -->
# Reading the dashboard

## Navigation

One sidebar: **Work**, **Workers**, **Shipped**, **Tests**, **Insights**, **Settings**.

## Work: one classification

Each open item is in one group: **Needs you** (only you may decide), **Blocked**, **Moving**, **Up next** or **Backlog**; a tile counts and filters one group.

`GET /api/board` serves the groups, not the page. Items carry `group`, `stage`, `owner`, `actor` (`worker`, `reviewer`, `producer`, `approver`, `master`, `executor`, `human-only`, `held`), `command` (or null), `since` and `overdue` (past `overdueAfterMs`). `master status` lists the master's items as `board.owed`.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), from the item, not from Herdr.

A running handle last observed over **15 minutes** by default, `sessionStaleThresholdMs` in `web/workers-view.ts`, reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Running rows offer:

- **Copy local**, on the launching host: `herdr agent attach w1V:pJD`.
- **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`; interactive attachment is not forwarded by `--machine`: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

[Research runs](master-agent.md#research-and-diagnosis) are **Researches** rows.

## The status sentence

Rows show **Research, Build, Validate, Test, Review, Prove, Merge, Deploy**. Research: **current** while live, **done** with a brief, else **skipped** (failed, bug, `research: false`, built briefless, unconfigured). Merged items read *Merged*, then *Live* once production serves it (counted this week). Moving and Blocked rows past thirty minutes turn overdue.

## An item page

Below the summary: **What is left**, **Requirements** (✓ or ○ per criterion), **Pull request**, **Test cases** and **Activity**. **Research brief** (collapsed): model, duration, tokens. **Technical details** holds gates, sessions, evidence and overlaps (`Shares files with GY-166, GY-167 (tests/)`).

## Insights

Headline numbers, **Flow** (Now columns show 12 dots, then **+N more**; medians survive a failed replay read), landed per day, merges/hour, median queue wait, time spent, research effect, [optimistic merges](github.md#optimistic-merges); **Show details** holds shipping pulse (PR-to-production from `POST /api/production-observations` or `master verify-deployment`) and flow analytics. **Shipped** holds **Interventions**, **Validation** and **Releases**; `GRAPHYARD_INTERVENTION_PATTERNS=1` files repeats as `bug` items. Missing values read `Unavailable`.
