<!-- page: Operate Graphyard | 3 | pages. -->
# Reading the dashboard

Sidebar: **Work**, **Workers**, **Shipped**, **Tests**, **Insights**, **Settings**.

## Work

One group per open item: **Needs you**, **Blocked**, **Moving**, **Up next**, **Backlog**. `GET /api/board` items carry `group`, `stage`, `owner`, `actor`, `command`, `since`, `overdue` (default 30 minutes).

## Needs you

`graphyard login` prints the operator's single-use sign-in link. **Provide now** seals credentials for `unseal GY-N`; an operator approval offers **Approve** or terminal **Decline** (`master refuse GY-N DECISION REASON`), answered only from a human admin's session.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), not from Herdr. A running handle last observed over **15 minutes** by default, `sessionStaleThresholdMs`, reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Running rows: **Copy local** (launching host) `herdr agent attach w1V:pJD`; **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`; interactive attachment is not forwarded, so focus, then attach: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

Settings › **Agents**: **Can launch now?** lists role chips and, per role that cannot launch, its reason and earliest time; **Accounts** shows one row per account with its state chip, **Usage** and **Why**; launch policy sits behind **Roles (N)**.

## The status sentence

Rows: **Build, Validate, Test, Review, Prove, Merge, Deploy**, then *Merged*, *Live*; an item page shows **What is left**, **Requirements**, **Pull request** (with **Merge danger**), **Test cases**, **Activity** and **Technical details**.

## Insights

**Flow**, shipping pulse, PR-to-production (`POST /api/production-observations`) and conflict hotspots; **Shipped** holds **Interventions** ([retro](operations-reference.md#retro-synthesis)), **Validation** and **Releases**.
