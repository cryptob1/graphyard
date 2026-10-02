<!-- page: Operate Graphyard | 3 | pages and markers. -->
# Reading the dashboard

## Navigation

One sidebar: **Work**, **Workers**, **Shipped**, **Tests**, **Insights**, **Settings**.

## Work: one classification

Each open item is in one group: **Needs you** (only you may decide), **Blocked**, **Moving**, **Up next** or **Backlog**; a tile counts and filters one group.

`GET /api/board` serves the groups, not the page. Items carry `group`, `stage`, `owner`, `actor` (`worker`, `reviewer`, `producer`, `approver`, `master`, `executor`, `human-only`, `held`), `command` (or null), `since` and `overdue` (past `overdueAfterMs`). `master status` lists the master's items as `board.owed`.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), from the item, not from Herdr.

A running handle last observed over **15 minutes** by default, `sessionStaleThresholdMs` in `web/workers-view.ts`, reads *not seen for <time since that observation>*, never as running, and is not counted among the open sessions; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Running rows offer:

- **Copy local**, on the launching host: `herdr agent attach w1V:pJD`.
- **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>`, `herdr --remote <ssh-target>`; interactive attachment is not forwarded by `--machine`, so the form focuses the pane then attaches remotely: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## Settings › Agents: the fleet panel

**Can launch now?**: per role, can it launch, else why and when. **Accounts** lists CLI accounts grouped under their provider plan (Claude, Codex, Z.AI, Cursor, Muse, Antigravity). Each plan with reported usage shows a bar per usage window (percent used and reset countdown) or an explicit "usage not reported by <provider>" notice. CLI accounts that share a plan (e.g. `pi-X` and `opencode-X` sharing a Z.AI coding-plan key) group together and share one plan budget. Each account row shows its status chip, first that applies: Disabled, No role, Spent, Launch failing (failed smoke test, role hold, or a start failure within the hour), Unavailable, Working, Idle; times are local with a countdown (`web/agent-status.ts`). **Account details** holds each card with capability, login, and probe freshness; a quota reading over an hour old (`quotaStaleThresholdMs` in `web/pages/fleet.tsx`) is marked **old probe**, a failed smoke test **probe failed**. Settings pages share `web/components/page-layout.tsx`; operator identity ids wait behind **Identifiers**.

## The status sentence

Rows show **Build, Validate, Test, Review, Prove, Merge, Deploy**. A merged item reads *Merged*, then *Live* once production serves it (counted this week). Moving and Blocked rows past thirty minutes turn overdue.

## An item page

Below the summary: **What is left**, **Requirements** (✓ or ○ per criterion), **Pull request**, **Test cases** and **Activity**. **Pull request** folds a **Merge danger** (low, medium, high; one-way or two-way door): what the change touches, what a revert restores, what the merge guard still checks. Schema, deployment and workflow files are one-way. **Technical details** holds gates, sessions, evidence and overlaps (`Shares files with GY-166, GY-167 (tests/)`).

## Insights

Headline numbers, **Flow** (Now columns show 12 dots, then **+N more**; medians survive failed replay reads), landed/day, merges/hour, median queue wait, time spent, [optimistic merges](github.md#optimistic-merges); **Show details** holds shipping pulse (PR-to-production from `POST /api/production-observations` or `master verify-deployment`) and 24-hour to 90-day flow analytics. **Shipped** holds **Interventions**, **Validation** and **Releases**; `GRAPHYARD_INTERVENTION_PATTERNS=1` files repeats as `bug` items. Missing values read `Unavailable`.
