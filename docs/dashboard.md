<!-- page: Operate Graphyard | 3 | pages. -->
# Reading the dashboard

## Work: one classification

Each open item is in one group: **Needs you** (only you may decide), **Blocked**, **Moving**, **Up next** or **Backlog**; a tile counts and filters one group.

`GET /api/board` serves the groups: `group`, `stage`, `owner`, `actor`, `command`, `since`, `overdue`. `master status` lists the master's as `board.owed`.

## Needs you

`graphyard login` prints a single-use, ten-minute operator sign-in link. Requests offer choices and notes; **Provide now** seals credentials for `unseal GY-N`; a refused answer keeps the form.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), from the item, not from Herdr. A running handle last observed over **15 minutes** by default, `sessionStaleThresholdMs`, reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Running rows offer **Copy local**, `herdr agent attach w1V:pJD`, and **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`; interactive attachment is not forwarded, so it focuses, then attaches: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## Settings › Agents: the fleet panel

**Can launch now?**: per role, yes or why not, until when. **Accounts** groups accounts by provider plan (Claude, Codex, Z.AI, Cursor, Muse, Antigravity), a bar per usage window (percent used, reset countdown) or "usage not reported by <provider>"; chips, first that applies: Disabled, No role, Spent, Launch failing, Unavailable, Working, Idle (`web/agent-status.ts`). **Account details**: **old probe** past an hour (`quotaStaleThresholdMs`), **probe failed** after a failed smoke test.

## The status sentence

Rows show **Build, Validate, Test, Review, Prove, Merge, Deploy**; merged reads *Merged*, *Live* once production serves it. Moving and Blocked rows past thirty minutes turn overdue.

## An item page

**What is left**, **Requirements**, **Pull request** (**Merge danger** low/medium/high; schema, deployment and workflow files: one-way doors), **Test cases**, **Activity**, **Technical details**.

## Insights

**Flow**, [optimistic merges](github.md#optimistic-merges); **Show details**: flow analytics. **Shipped**: **Interventions** ([retro](operations-reference.md#retro-synthesis)), **Validation**, **Releases**.
