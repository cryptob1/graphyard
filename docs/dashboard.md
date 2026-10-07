<!-- page: Operate Graphyard | 3 | pages. -->
# Reading the dashboard

Sidebar: **Work**, **Workers**, **Shipped**, **Tests**, **Insights**, **Settings**.

## Work

Open items by group (tiles count, filter): **Needs you** (yours alone), **Blocked**, **Moving**, **Up next**, **Backlog**. `GET /api/board` items carry `group`, `stage`, `owner`, `actor`, `command`, `since`, `overdue` (Moving/Blocked past `overdueAfterMs`, 30 min); master-owed: `master status` `board.owed`.

## Needs you

`graphyard login`: single-use sign-in link; **Provide now** seals credentials for `unseal GY-N`; operator approvals offer **Approve** or terminal **Decline** (`master refuse GY-N DECISION REASON`), answered only from human admin sessions.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles) from the item, not from Herdr. A running handle last observed over **15 minutes** by default, `sessionStaleThresholdMs` (`web/workers-view.ts`), reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

**Copy local** (launching host): `herdr agent attach w1V:pJD`; **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`; interactive attachment is not forwarded, so focus, then attach: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

Settings › **Agents**: **Can launch now?** role chips (titles name next account); blocked roles' reason, earliest time. **Accounts** rows (working, idle, out of work): state chip (Disabled, No role, Spent, Launch failing, Unavailable, Working, Idle), **Usage** (bar, percent, hover reset; — unreported), **Why** (live work or refusal); shared plans get header; same-day spent collapse (*4 spent until Oct 8*). **Roles (N)**: preference, launch policy.

## The status sentence

**Build, Validate, Test, Review, Prove, Merge, Deploy**, then *Merged*, *Live* once served. Item page: **What is left**, **Requirements** (✓/○), **Pull request** (**Merge danger** low/medium/high), **Test cases**, **Activity**, **Technical details** (gates, sessions, evidence, overlaps).

## Insights

**Flow** (landed/day, merges/hour, waits); **Show details**: shipping pulse, PR-to-production (`POST /api/production-observations`), flow analytics, conflict hotspots. **Shipped**: **Interventions** ([retro](operations-reference.md#retro-synthesis); repeats filed `bug`), **Validation**, **Releases**. Reworks on a loop-handled ground (base conflict, failed required check, change request, merge refusal, failed proof) aren't interventions, whoever asked, until an approver declines one.
