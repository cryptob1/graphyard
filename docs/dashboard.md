<!-- page: Operate Graphyard | 3 | pages and markers. -->
# Reading the dashboard

## Work: one classification

Groups (one per open item; tiles filter): **Needs you** (only you may decide), **Blocked**, **Moving**, **Up next**, **Backlog**. `GET /api/board` items carry `group`, `stage`, `owner`, `actor` (`worker`, `reviewer`, `producer`, `approver`, `master`, `executor`, `human-only`, `held`), `command`, `since` and `overdue` (Moving or Blocked past `overdueAfterMs`, default thirty minutes). `master status`: the master's in `board.owed`.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), from the item, not from Herdr. A running handle last observed over **15 minutes** by default, `sessionStaleThresholdMs`, reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Running rows offer **Copy local** (launching host), `herdr agent attach w1V:pJD`, and **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`; interactive attachment is not forwarded by `--machine`, so it focuses, then attaches: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## Settings › Agents: the fleet panel

**Can launch now?**: per role, yes or why not until when. **Accounts**: one chip each, first of Disabled, No role, Spent, Launch failing (failed smoke test, role hold, start failure this hour), Unavailable, Working, Idle. **Account details**: **old probe** for quota readings over an hour old (`quotaStaleThresholdMs`), **probe failed** for failed smoke tests.

## The status sentence

Rows show **Build, Validate, Test, Review, Prove, Merge, Deploy**, then *Merged*, then *Live* once served.

## An item page

**What is left**, **Requirements** (✓/○ per criterion), **Pull request** (with **Merge danger**: low/medium/high; schema, deployment and workflow files are one-way doors), **Test cases**, **Activity**; **Technical details**: gates, sessions, evidence, file overlaps.

## Insights

Headline numbers, **Flow** (12 dots per Now column, then **+N more**), [optimistic merges](github.md#optimistic-merges); **Show details**: shipping pulse (from `POST /api/production-observations` or `master verify-deployment`), flow analytics. **Shipped**: **Interventions**, **Validation**, **Releases**; `GRAPHYARD_INTERVENTION_PATTERNS=1` files repeats as `bug` items. Missing values read `Unavailable`.
