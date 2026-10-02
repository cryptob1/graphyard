<!-- page: Operate Graphyard | 3 | pages and markers. -->
# Reading the dashboard

## Work: one classification

One group per open item: **Needs you** (yours alone), **Blocked**, **Moving**, **Up next**, **Backlog**. `GET /api/board` items carry `group`, `stage`, `owner`, `actor`, `command`, `since`, `overdue` (Moving or Blocked past `overdueAfterMs`, default 30 minutes); `master status`: the master's in `board.owed`.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), from the item, not from Herdr. A running handle last observed over **15 minutes** by default, `sessionStaleThresholdMs`, reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Running rows offer **Copy local**, `herdr agent attach w1V:pJD`, and **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`; interactive attachment is not forwarded, so it focuses, then attaches: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## Settings › Agents: the fleet panel

**Can launch now?**: per role, yes or why not, until when. **Accounts**: one state chip each. **Account details**: **old probe** past an hour (`quotaStaleThresholdMs`), **probe failed** after a failed smoke test.

## The status sentence

Rows show **Build, Validate, Test, Review, Prove, Merge, Deploy**, then *Merged*, *Live* once served.

## An item page

**What is left**, **Requirements**, **Pull request** (**Merge danger** low/medium/high; schema, deployment and workflow files: one-way doors), **Test cases**, **Activity**, **Technical details**.

## Insights

**Flow**, [optimistic merges](github.md#optimistic-merges); **Show details**: shipping pulse, 24-hour to 90-day flow analytics. **Shipped**: **Interventions** ([retro](operations-reference.md#retro-synthesis)), **Validation**, **Releases**.
