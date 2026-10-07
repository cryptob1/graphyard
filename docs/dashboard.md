<!-- page: Operate Graphyard | 3 | pages. -->
# Reading the dashboard

Sidebar: **Work**, **Workers**, **Shipped**, **Tests**, **Insights**, **Settings**.

## Work

Open items by group (tiles count, filter): **Needs you** (yours alone), **Blocked**, **Moving**, **Up next**, **Backlog**. `GET /api/board` items carry `group`, `stage`, `owner`, `actor`, `command`, `since`, `overdue` (Moving/Blocked past `overdueAfterMs`, 30 min); master-owed: `master status` `board.owed`.

## Needs you

Cards: ask, **Recommended** choice (or safest way), one-line why, numbered steps, choices (recommended first, preselected); agent detail folds under **Details for agents** (older requests: need's first sentence). `graphyard login`: single-use sign-in link; **Provide now** seals credentials for `unseal GY-N`; operator approvals offer **Approve** or terminal **Decline** (`master refuse GY-N DECISION REASON`), answered only from human admin sessions.

## Workers

**Workers** (sidebar, beside Shipped and Insights; `web/pages/index.tsx`): a row is one [session handle](master-agent-sessions.md#session-handles) from the item, not from Herdr. A running handle unobserved over **15 minutes** by default (`sessionStaleThresholdMs`, `web/workers-view.ts`) reads *not seen for <time since that observation>*, never as running, and isn't counted open; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) ends a dead handle.

**Copy local** (launching host): `herdr agent attach w1V:pJD`; **Copy remote** (`herdr --machine <label-or-id> <command>`, `herdr --remote <ssh-target>` per `herdr --help`; attachment isn't forwarded: focus, then attach): `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## Settings › Agents

**Can launch now?** role chips (titles name next account; blocked roles: reason, earliest time). **Accounts** rows (working, idle, out of work): state chip (Disabled, No role, Spent, Launch failing, Unavailable, Working, Idle), **Usage** (bar, percent, hover reset; — unreported), **Why** (live work or refusal); shared plans head groups; same-day spent collapse (*4 spent until Oct 8*). **Roles (N)**: preference, launch policy.

## The status sentence

**Build, Validate, Test, Review, Prove, Merge, Deploy**, then *Merged*, *Live* once served. Item page: **What is left**, **Requirements** (✓/○), **Pull request** (**Merge danger** low/medium/high), **Test cases**, **Activity**, **Technical details** (gates, sessions, evidence, overlaps).

## Insights

**Flow** (landed/day, merges/hour, waits); **Show details**: shipping pulse, PR-to-production (`POST /api/production-observations`), flow analytics, conflict hotspots. **Shipped**: **Interventions** ([retro](operations-reference.md#retro-synthesis); repeats filed `bug` unless `GRAPHYARD_INTERVENTION_PATTERNS=0`), **Validation**, **Releases**. Reworks on loop-handled ground (base conflict, failed required check, change request, merge refusal, failed proof) aren't interventions, whoever asked, until approver declines one; nor are loop operator agent's recorded-ground rounds (capped change requests to its approver included) applied by risk lane or operator agent; hand-approved or hand-applied ones count; pre-window decision counts only for in-window outcome naming it.
