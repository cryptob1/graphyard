<!-- page: Operate Graphyard | 3 | pages. -->
# Reading the dashboard

## Navigation

One sidebar: **Work**, **Workers**, **Shipped**, **Tests**, **Insights**, **Settings**.

## Work: one classification

Each open item is in one group: **Needs you** (only you decide), **Blocked**, **Moving**, **Up next** or **Backlog**; a tile counts and filters one.

`GET /api/board` serves the groups. Items carry `group`, `stage`, `owner`, `actor` (a role), `command` (or null), `since`, `overdue` (`overdueAfterMs`). `master status` lists the master's as `board.owed`.

## Needs you

`graphyard login` prints a single-use, ten-minute sign-in link for the operator's human session; others get **Sign in as the operator**. Requests offer choice buttons and notes; **Provide now** seals credentials for `graphyard unseal GY-N`.

## Workers

**Workers** is a sidebar entry in `web/pages/index.tsx`; a row is one [session handle](master-agent-sessions.md#session-handles), from the item, not from Herdr.

A handle unobserved over **15 minutes** (`sessionStaleThresholdMs`) reads *not seen for <time since that observation>*, never as running, outside the open-session count; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) ends a dead handle.

Running rows offer:

- **Copy local** (launching host): `herdr agent attach w1V:pJD`.
- **Copy remote**: `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`; `--machine` does not forward interactive attachment, so it focuses the pane then attaches remotely: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## The status sentence

Rows show **Build, Validate, Test, Review, Prove, Merge, Deploy**. A merged item reads *Merged*, then *Live* once production serves it (counted this week). Moving and Blocked rows past thirty minutes turn overdue.

## An item page

Below the summary: **What is left**, **Requirements** (✓ or ○ per criterion), **Pull request**, **Test cases** and **Activity**. **Technical details** holds gates, sessions, evidence, overlaps.

## Insights

Headline numbers, **Flow** (Now columns show 12 dots, then **+N more**; medians survive a failed replay read), landed per day, merges/hour, median queue wait, time spent, [optimistic merges](github.md#optimistic-merges); **Show details** holds shipping pulse, PR-to-production (`POST /api/production-observations`, `master verify-deployment`), and flow analytics. **Shipped** holds **Interventions**, **Validation** and **Releases**; `GRAPHYARD_INTERVENTION_PATTERNS=1` files repeats as `bug` items; missing values read `Unavailable`.
