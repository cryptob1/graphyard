<!-- page: Operate Graphyard | 3 | pages. -->
# Reading the dashboard

Sidebar: **Work**, **Workers**, **Shipped**, **Tests**, **Insights**, **Settings**.

## Work

One group per open item (a tile counts and filters it): **Needs you** (yours alone), **Blocked**, **Moving**, **Up next**, **Backlog**. `GET /api/board` items carry `group`, `stage`, `owner`, `actor`, `command`, `since`, `overdue` (Moving/Blocked past `overdueAfterMs`, default 30 minutes). `master status` lists the master's as `board.owed`.

## Needs you

`graphyard login` prints the operator's single-use sign-in link. Requests offer choices; **Provide now** seals credentials for `unseal GY-N`.

An operator approval offers **Approve** or terminal **Decline** (`master refuse GY-N DECISION REASON`), answered only from a human admin's sign-in session.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), from the item, not from Herdr. A running handle last observed over **15 minutes** by default, `sessionStaleThresholdMs` (`web/workers-view.ts`), reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Running rows: **Copy local** (launching host) `herdr agent attach w1V:pJD`; **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`; interactive attachment is not forwarded, so focus, then attach: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## Settings › Agents

**Can launch now?** is one line of role chips (each chip's title names its next account), plus one line per role that cannot launch, with its reason and earliest time. **Accounts** is one row per account, ordered working, idle, then out of work, each with one state chip (Disabled, No role, Spent, Launch failing, Unavailable, Working, Idle) and a **Usage** column (bar and percent, reset on hover; a muted — when unreported). Only a plan shared by two or more accounts keeps a header row. **Why** shows live work or a refusal, never what Roles, Back or Usage already say. Spent accounts back on the same day collapse into one *4 spent until Oct 8* row that opens on click. Preference order and launch policy sit behind **Roles (N)**.

## The status sentence

Rows: **Build, Validate, Test, Review, Prove, Merge, Deploy**, then *Merged*, *Live* once served.

## An item page

**What is left**; **Requirements** (✓/○); **Pull request** with **Merge danger** (low/medium/high); **Test cases**; **Activity**; **Technical details** (gates, sessions, evidence, overlaps).

## Insights

**Flow** (landed/day, merges/hour, waits); **Show details**: shipping pulse, PR-to-production (`POST /api/production-observations`), flow analytics, conflict hotspots. **Shipped**: **Interventions** ([retro](operations-reference.md#retro-synthesis); repeats are filed as `bug` items unless `GRAPHYARD_INTERVENTION_PATTERNS=0`; a rework the loop requested on recorded grounds — a change request, failed check, conflict or mechanical finding — that the risk lane or an operator agent applied is a review round, not an intervention; one requested, approved or applied by hand still counts), **Validation**, **Releases**.
