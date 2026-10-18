<!-- page: Operate Graphyard | 3 | pages. -->
# Reading the dashboard

Sidebar: **Work**, **Workers**, **Shipped**, **Tests**, **Insights**, **Settings**.

## From your phone

Serves `127.0.0.1:4310` or the install's free port ([install](install.md)). With Tailscale, `up` prints `tailscale serve --bg --http=4310 http://127.0.0.1:4310` plus tailnet URL; `--share-tailnet` runs it (never `funnel`), `reachableUrl` (`up.json`) feeds sign-in links. A green `up` ends with a single-use `signIn` link (10min).

## Work

Open items: **Needs you**, **Blocked**, **Moving**, **Up next**, **Backlog**. `GET /api/board` items carry `group`, `stage`, `owner`, `actor`, `command`, `since`, `outcome`, `overdue` (Moving/Blocked past `overdueAfterMs`, 30min); master-owed: `master status` `board.owed`. Blocked rows name their clearer (`blocker.summary`; a wait's UTC `until`).

## Needs you

Cards: ask, **Recommended** choice, one-line why, numbered steps, choices; agent detail under **Details for agents**. `graphyard login`: single-use sign-in link; **Provide now** seals credentials for `unseal GY-N`; operator approvals offer **Approve** or terminal **Decline** (`master refuse GY-N DECISION REASON`); human admins only.

## Workers

**Workers** (sidebar, beside Shipped and Insights; `web/pages/index.tsx`): a row is one [session handle](master-agent-sessions.md#session-handles) from the item, not from Herdr. A running handle unobserved over **15 minutes** by default (`sessionStaleThresholdMs`) reads *not seen for <time since that observation>*, never as running, and isn't counted open; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) ends a dead handle.

**Copy local**: `herdr agent attach w1V:pJD`; **Copy remote** (`herdr --machine <label-or-id> <command>`, `herdr --remote <ssh-target>` per `herdr --help`; attachment isn't forwarded): `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## Settings › Agents

**Can launch now?** role chips (blocked: reason, earliest time). **Accounts**: state chip (Disabled, No role, Spent, Launch failing, Unavailable, Working, Idle), **Usage**, **Why**; same-day spent accounts collapse. **Roles (N)**: preference, launch policy.

## The status sentence

**Build, Validate, Test, Review, Prove, Merge, Deploy**; done items are *Delivered* at merge (steps end at Merge); *Live* once served. Item page leads with `summary`, state, **What is left**, folded **Details** (description, criteria), **Pull request** (**Merge danger**), **Test cases**, **Activity**, **Technical details** (gates, sessions, evidence, overlaps, verbatim blocker). `/goals/KEY`: summary, outcomes, Todo/Doing/Checking/Done flowchart, **Play**.

## Insights

**Flow**; **Show details**: shipping pulse, PR-to-production (`POST /api/production-observations`), analytics, conflict hotspots. **Shipped**: **Interventions** ([retro](operations-reference.md#retro-synthesis); repeats are attention, never items; pattern: owners, causes, rounds, [under-threshold days](protocol/read-endpoints.md)), **Validation**, **Releases**.
