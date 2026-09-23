<!-- page: Operate Graphyard | 3 | the numbers. -->
# Reading the dashboard

For anyone looking at the control plane: what is being worked on, and what is stuck.

**Work** holds open items grouped by what needs attention and **Shipped** every delivered item, newest first, with its pull request and whether the deployment serves it; **Insights** tabs Shipping pulse, Flow analytics, Validation and Releases, **Settings** tabs Test cases, Proof authority and Operator automation.

The **Agent fleet** page is opened from the fleet line under the Work heading or from Operator automation, not as a tab: it shows the [agent registry](fleet.md#the-agent-registry) — each role's preference order, sessions running against its concurrency limit and the account its next action would run on; each account's runtime, model, cost and capability, roles, live sessions, login, quota, reset and the reason it cannot take a session; each runtime's launch contract; and the recent selections with their reasons. Admin and coordinator sessions also get the forms that configure it, each with an audit reason ([onboarding](onboarding.md#configure-the-fleet)). It names hosts and login homes, so worker, producer and operator-agent sessions do not see it.

## Needs you

**Work → Needs you** lists every open [human-only request](master-loop.md#human-only-waits), longest wait first: the item, the exact thing needed, which of the three decisions it is, who asked and why, how long it has waited, and `graphyard answer GY-N REQUEST ANSWER`. An item listed here holds no worker and delays nothing else, and on the home page reads `Stuck: Waiting on a human-only decision (…): NEEDED`. A declared human `admin` session gets an answer box: **Answer and resume** posts `work/GY-N/answer` and the loop dispatches the item on its next cycle with the answer in the new worker's prompt, **Decline** keeps it parked with your words as its blocker. Agent sessions see the requests but never the form, and the server refuses their answers. Recently answered requests stay listed underneath with the answer and how long it waited.

## The status sentence

Every card, and the top of every item view, carries one sentence from the item's first refusing gate — *Waiting for review of PR #42*, *Stuck: needs a second Postgres instance*. An unrecognised reason reads as its step, never raw internal text.

**Stuck**: the item will not move until someone decides or fixes something:

- Recorded blocker
- Standing escalation or lead hold
- Merge conflict
- Pull request changing files outside its plan
- No available reviewer
- Proof that no longer counts

## Home page and item view

- **Board view** draws a column for every open stage, empty ones included
- **One source:** `homeNumbers` in `web/home-numbers.ts` returns one field per number drawn, and `unit:home-numbers-reconcile`, `unit:work-page-single-count-row`, `unit:work-page-no-derived-totals` and `integration:work-page-density` hold the page to it
- **Item view** opens with the status sentence, owner, pull request and the one blocker
- **Steps** lists the gates in order
- **What must be true** lists each acceptance criterion once with one marker per proof: ✓ passed, ○ pending, × failed or withdrawn
- **More details** holds the rest: metadata, policy and revision, worker, assignment and workspaces, coordination diagnosis, file overlaps, merge-queue position, review provider, raw gate reasons, proof details, bootstrap obligations, observed delivery, evidence with artifacts, and history; an admin session gets an **Edit** menu for the review provider, a fresh review and requirement revisions.

## Candidate links and definitions

- **Unconfigured or failing validation:** renders as selectable plain text

## Connection

The access token is verified before any work or status displays, a rejected one returning to the sign-in form with an error. A polling failure keeps the last snapshot with a stale-data warning and retries every five seconds; the snapshot is informational, the server authorizes every mutation, and the 300-event display limit never truncates the ledger.
