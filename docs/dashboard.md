<!-- page: Operate Graphyard | 3 | pages. -->
# Reading the dashboard

Sidebar: **Work**, **Workers**, **Shipped**, **Tests**, **Insights**, **Settings**.

## From your phone

A local dashboard listens on `127.0.0.1:4310`, or the install's free port ([install](install.md)). With Tailscale, `graphyard up` prints `tailscale serve --bg --http=4310 http://127.0.0.1:4310` and its tailnet URL; `--share-tailnet` runs it, keeps `up.json` `reachableUrl`, sign-in links use it, never `funnel`. A green `up` ends with one single-use sign-in link (`signIn`, 10min).

## Work

Open items by group: **Needs you**, **Blocked**, **Moving**, **Up next**, **Backlog** — the item states (GY-1979) are **Todo** (no lease, nothing handed in), **Doing** (a worker holds it, not handed in), **Checking** (handed in: the validate, test, review, proof and merge gates folded into one state whose label names what it waits on); a merged item is **Done** and leaves the board (search and its page still reach it). Moving rows and the item page draw the four-state bar; **What is left** lists each unmet requirement under its state. `GET /api/board` items carry `group`, `stage`, `owner`, `actor`, `command`, `since`, `overdue` (Moving/Blocked past `overdueAfterMs`, 30min); master-owed: `master status` `board.owed`. Blocked rows: one sentence naming its clearer (`blocker.summary`; a wait's UTC `until`).

## The release line

The top bar's one release line (GY-1979): the commit production serves (whole SHA on hover), its health — an open deployment incident reads *unhealthy* — and the merged changes it does not carry yet; with no production observation it says so. The deployment is never an item state: merged is Done however the release lags.

## Needs you

Cards: ask, **Recommended** choice, one-line why, numbered steps, choices; agent detail folds under **Details for agents**. `graphyard login`: single-use sign-in link; **Provide now** seals credentials for `unseal GY-N`; operator approvals offer **Approve** or terminal **Decline** (`master refuse GY-N DECISION REASON`); human admin sessions only.

## Workers

**Workers** (sidebar, beside Shipped and Insights; `web/pages/index.tsx`): a row is one [session handle](master-agent-sessions.md#session-handles) from the item, not from Herdr. A running handle unobserved over **15 minutes** by default (`sessionStaleThresholdMs`) reads *not seen for <time since that observation>*, never as running, and isn't counted open; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) ends a dead handle.

**Copy local**: `herdr agent attach w1V:pJD`; **Copy remote** (`herdr --machine <label-or-id> <command>`, `herdr --remote <ssh-target>` per `herdr --help`; attachment isn't forwarded: focus, then attach): `herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`.

## Settings › Agents

**Can launch now?** role chips (blocked: reason, earliest time). **Accounts** rows: state chip (Disabled, No role, Spent, Launch failing, Unavailable, Working, Idle), **Usage**, **Why**; same-day spent accounts collapse. **Roles (N)**: preference, launch policy.

## The status sentence

Done items headline their production state on the plain status their page reads: *Merged, awaiting deployment*, *Deployed, awaiting verification*, *Production verified*, *Deployed with a failure*; *Live* once served. Item page: **What is left**, **Requirements**, **Pull request** (**Merge danger**), **Test cases**, **Activity**, **Technical details** (gates, sessions, evidence, overlaps, verbatim blocker). The Insights Flow panel and the replay still read the recorded steps — the gate facts keep that vocabulary.

## Insights

**Flow**; **Show details**: shipping pulse, PR-to-production (`POST /api/production-observations`), analytics, conflict hotspots. **Shipped**: **Interventions** ([retro](operations-reference.md#retro-synthesis); repeats are attention, never items; pattern: owners, causes, rounds, [under-threshold days](protocol/read-endpoints.md)), **Validation**, **Releases**.
