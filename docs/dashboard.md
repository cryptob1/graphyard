<!-- page: Operate Graphyard | 3 | pages. -->
# Reading the dashboard

Sidebar: **Work**, **Workers**, **Shipped**, **Tests**, **Insights**, **Settings**.

## From your phone

A local (compose) dashboard listens on `127.0.0.1:4310`, or the free port its install chose ([install](install.md)). With Tailscale, `graphyard up` prints `tailscale serve --bg --http=4310 http://127.0.0.1:4310` and its tailnet URL; `--share-tailnet` runs it, keeps it in `up.json` (`reachableUrl`) and its sign-in links use it: tailnet-only, never `tailscale funnel`. A green `up` ends with one single-use sign-in link (`signIn`, 10 minutes).

## Work

Open items by group: **Needs you** (yours alone), **Blocked**, **Moving**, **Up next**, **Backlog**. `GET /api/board` items carry `group`, `stage`, `owner`, `actor`, `command`, `since`, `overdue` (Moving/Blocked past `overdueAfterMs`, 30 min); master-owed: `master status` `board.owed`.

## Needs you

Cards: ask, **Recommended** choice (or safest way), one-line why, numbered steps, choices (recommended first, preselected); agent detail folds under **Details for agents**. `graphyard login`: single-use sign-in link; **Provide now** seals credentials for `unseal GY-N`; operator approvals offer **Approve** or terminal **Decline** (`master refuse GY-N DECISION REASON`), answered only from human admin sessions.

## Workers

**Workers** (sidebar, beside Shipped and Insights; `web/pages/index.tsx`): a row is one [session handle](master-agent-sessions.md#session-handles) from the item, not from Herdr. A running handle unobserved over **15 minutes** by default (`sessionStaleThresholdMs`, `web/workers-view.ts`) reads *not seen for <time since that observation>*, never as running, and isn't counted open; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) ends a dead handle.

**Copy local** (launching host): `herdr agent attach w1V:pJD`; **Copy remote** (`herdr --machine <label-or-id> <command>`, `herdr --remote <ssh-target>` per `herdr --help`; attachment isn't forwarded: focus, then attach): `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## Settings › Agents

**Can launch now?** role chips (blocked roles: reason, earliest time). **Accounts** rows: state chip (Disabled, No role, Spent, Launch failing, Unavailable, Working, Idle), **Usage** (bar, percent), **Why** (live work or refusal); same-day spent accounts collapse. **Roles (N)**: preference, launch policy.

## The status sentence

**Build, Validate, Test, Review, Prove, Merge, Deploy**, then *Merged*, *Live* once served. Item page: **What is left**, **Requirements** (✓/○), **Pull request** (**Merge danger** low/medium/high), **Test cases**, **Activity**, **Technical details** (gates, sessions, evidence, overlaps).

## Insights

**Flow** (landed/day, merges/hour, waits); **Show details**: shipping pulse, PR-to-production (`POST /api/production-observations`), flow analytics, conflict hotspots. **Shipped**: **Interventions** ([retro](operations-reference.md#retro-synthesis); repeats filed `bug` unless `GRAPHYARD_INTERVENTION_PATTERNS=0`), **Validation**, **Releases**. Reworks on loop-handled ground (base conflict, failed required check, change request, merge refusal, failed proof) aren't interventions, whoever asked, until approver declines one; hand-approved or hand-applied ones count.
