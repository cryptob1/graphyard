<!-- page: Operate Graphyard | 3 | pages. -->
# Reading the dashboard

## Navigation

One sidebar: **Work**, **Workers**, **Shipped**, **Tests**, **Insights**, **Settings**.

## Work: one classification

Each open item is in one group: **Needs you** (only you may decide), **Blocked**, **Moving**, **Up next** or **Backlog**; a tile counts and filters one group.

`GET /api/board` serves the groups: `group`, `stage`, `owner`, `actor` (a role), `command`, `since`, `overdue`. `master status` lists the master's as `board.owed`.

## Needs you

`graphyard login` prints a single-use, ten-minute sign-in link for the operator's human session; others get **Sign in as the operator**. Requests offer choice buttons and notes; **Provide now** seals credentials for `unseal GY-N`. A refused answer keeps everything typed in the form for the retry; the card clears only once the answer succeeds.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), from the item, not from Herdr.

A running handle last observed over **15 minutes** by default, `sessionStaleThresholdMs` in `web/workers-view.ts`, reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Running rows offer:

- **Copy local**, on the launching host: `herdr agent attach w1V:pJD`.
- **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>`, `herdr --remote <ssh-target>`; interactive attachment is not forwarded by `--machine`, so the form focuses the pane then attaches remotely: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## The status sentence

Rows show **Build, Validate, Test, Review, Prove, Merge, Deploy**; a merged item reads *Merged*, *Live* once production serves it. Moving and Blocked rows past thirty minutes turn overdue.

## An item page

Below the summary: **What is left**, **Requirements** (✓ or ○ per criterion), **Pull request**, **Test cases** and **Activity**. **Technical details** holds gates, sessions, evidence and overlaps (`Shares files with GY-166, GY-167 (tests/)`).

## Insights

Headline numbers, **Flow** (Now columns show 12 dots, **+N more**; medians survive a failed replay), landed per day, merges/hour, queue wait, time spent, [optimistic merges](github.md#optimistic-merges); **Show details** holds shipping pulse, PR-to-production (`POST /api/production-observations`, `master verify-deployment`) and flow analytics. **Shipped** holds **Interventions**, **Validation**, **Releases**; `GRAPHYARD_INTERVENTION_PATTERNS=1` file repeats as `bug` items; missing values read `Unavailable`.
