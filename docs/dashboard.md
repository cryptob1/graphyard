<!-- page: Operate Graphyard | 3 | pages, markers. -->
# Reading the dashboard

One sidebar: **Work**, **Workers**, **Shipped**, **Tests**, **Insights**, **Settings**.

## Work: one classification

Each open item sits in one tile-counted, filterable group: **Needs you** (only you decide), **Blocked**, **Moving**, **Up next**, **Backlog**. `GET /api/board` serves them; items carry `group`, `stage`, `owner`, `actor` (`worker`, `reviewer`, `producer`, `approver`, `master`, `executor`, `human-only`, `held`), `command` (or null), `since`, `overdue` (past `overdueAfterMs`). `master status` lists the master's as `board.owed`.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), from the item, not from Herdr.

A running handle last observed over **15 minutes** by default, `sessionStaleThresholdMs`, reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle. Running rows offer **Copy local** (launching host): `herdr agent attach w1V:pJD`; and **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>`, `herdr --remote <ssh-target>`, but interactive attachment is not forwarded by `--machine`, so it focuses then attaches: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## Settings › Agents: the fleet panel

**Can launch now?**: per role, yes, or why not and until when. **Accounts**: one chip per account, the first applying of Disabled, No role, Spent, Launch failing (failed smoke test, role hold, start failure within the hour), Unavailable, Working, Idle; local times with countdown. **Account details** cards mark quota readings over an hour old (`quotaStaleThresholdMs`) **old probe**, failed smoke tests **probe failed**; operator identity ids hide behind **Identifiers**.

## The status sentence

Rows show **Build, Validate, Test, Review, Prove, Merge, Deploy**, then *Merged*, then *Live* once production serves them (counted this week). Moving and Blocked rows go overdue after thirty minutes.

## An item page

**What is left**, **Requirements** (✓/○ per criterion), **Pull request**, **Test cases**, **Activity**. **Pull request** folds **Merge danger** (low/medium/high; one-way door for schema, deployment or workflow files, else two-way): what the change touches, a revert restores, the merge guard still checks. **Technical details** holds gates, sessions, evidence and overlaps (`Shares files with GY-166, GY-167 (tests/)`).

## Insights

Headline numbers; **Flow** (Now columns show 12 dots, then **+N more**; medians survive a failed replay read); landed per day, merges/hour, median queue wait, time spent, [optimistic merges](github.md#optimistic-merges). **Show details**: shipping pulse (PR-to-production via `POST /api/production-observations` or `master verify-deployment`) and flow analytics. **Shipped**: **Interventions**, **Validation**, **Releases**; `GRAPHYARD_INTERVENTION_PATTERNS=1` files repeats as `bug` items. Missing values read `Unavailable`.
