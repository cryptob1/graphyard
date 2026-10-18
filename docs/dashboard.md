<!-- page: Operate Graphyard | 3 | pages. -->
# Reading the dashboard

Sidebar: **Work**, **Workers**, **Shipped**, **Tests**, **Insights**, **Settings**. 
## From your phone

A local dashboard listens on `127.0.0.1:4310` or the install's free port ([install](install.md)); with Tailscale, `graphyard up` prints a tailnet URL. A green `up` ends with a sign-in link.

## Work

Open items by group: **Needs you**, **Blocked**, **Moving**, **Up next**, **Backlog** — the item states (GY-1979) are **Todo** (no lease, nothing handed in), **Doing** (a worker holds it, not handed in), **Checking** (handed in: the validate, test, review, proof and merge gates folded into one state whose label names what it waits on); a merged item is **Done** and leaves the board (search and its page still reach it). Moving rows and the item page draw the four-state bar; **What is left** lists each unmet requirement under its state. Blocked rows say who clears them; master-owed: `master status`.

## The release line

The top bar's one release line (GY-1979): the commit production serves (whole SHA on hover), its health — an open deployment incident reads *unhealthy* — and the merged changes it does not carry yet; with no production observation it says so. The deployment is never an item state: merged is Done however the release lags.

## Needs you

Cards: ask, **Recommended** choice, one-line why, numbered steps; agent detail folds under **Details for agents**. **Provide now** seals credentials for `unseal GY-N`; approvals offer **Approve** or terminal **Decline** (`master refuse GY-N DECISION REASON`); human admin sessions only.

## Workers

A row is one [session handle](master-agent-sessions.md#session-handles) from the item, not from Herdr. Running but unobserved over **15 minutes** (`sessionStaleThresholdMs`) reads *not seen*, never running, and isn't counted open; the loop's [session report](master-agent.md#session-liveness-is-reconciled-not-trusted) ends a dead handle.

## Settings › Agents

**Can launch now?** role chips (blocked: reason, earliest). **Accounts**: state chip, **Usage**, **Why**; same-day spent accounts collapse.

## The status sentence

Done items headline their production state (*Merged, awaiting deployment*, *Deployed, awaiting verification*, *Production verified*, *Deployed with a failure*; *Live* once served). The Insights Flow panel and replay still read the recorded steps — the gate facts keep that vocabulary.

## Insights

**Flow**; **Show details**: shipping pulse, PR-to-production, analytics, conflict hotspots. **Shipped**: **Interventions** ([retro](operations-reference.md#retro-synthesis); repeats are attention, never items), **Validation**, **Releases**.
