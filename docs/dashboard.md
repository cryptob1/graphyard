<!-- page: Operate Graphyard | 3 | what each page and marker means. -->
# Reading the dashboard

## Navigation

One sidebar: **Work**, **Workers**, **Shipped**, **Tests** (planned, GY-162), **Insights**, **Settings**.

## Work: one classification

Each open item is in one group: **Needs you** (only you may decide), **Blocked**, **Moving**, **Up next** or **Backlog**. A tile counts and filters one group.

## Workers

**Workers** is its own sidebar entry, registered beside Shipped and Insights in `web/pages/index.tsx`. A row is one [session handle](master-agent-sessions.md#session-handles), read from polled work items, not from Herdr.

A handle recorded running whose `updatedAt` is older than **15 minutes** by default, `sessionStaleThresholdMs` in `web/workers-view.ts`, reads *not seen for <time since updatedAt>*, never as running, and is not counted among the open sessions; GY-113's [liveness reconciliation](master-agent.md#session-liveness-is-reconciled-not-trusted) is what ends a dead handle.

Running rows offer:

- **Copy local**, on the launching host: `herdr agent attach w1V:pJD`.
- **Copy remote**: `herdr --help` documents `herdr --machine <label-or-id> <command>` and `herdr --remote <ssh-target>`, and interactive attachment is not forwarded by `--machine`, so the form focuses the pane then attaches remotely: `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## The status sentence

Rows show the steps **Build, Validate, Test, Review, Prove, Merge, Deploy** (`web/pr-steps.ts`), the current one named. A merged item reads *Merged* until production serves it, then *Live* (counted this week). Moving and Blocked rows time their step: past thirty minutes, `1h 12m overdue`.

## An item page

Below the summary: **What is left** (unmet requirements by step, who clears each, in plain words, never raw), **Requirements** (✓ or ○ per criterion, full text on click), **Pull request** (link, commit, files, checks, review) and **Activity** (latest events; history, minus routine checks, on click). Collapsed **Technical details** holds gate decisions, sessions with attach commands, review provider, next action, executors, agent requests and evidence; overlaps read `Shares files with GY-166, GY-167 (tests/)`.

## Insights

Headline numbers, **Flow** replay, landed per day, where time goes; **Show details** holds shipping pulse (PR-to-production from `POST /api/production-observations` or `master verify-deployment`) and flow analytics. **Shipped** holds **Interventions**, **Validation** and **Releases**; `GRAPHYARD_INTERVENTION_PATTERNS=1` files repeats as `bug` items. Missing values read `Unavailable`, never zero.
