<!-- page: Operate Graphyard | 3 | what each number means. -->
# Reading the dashboard

For anyone looking at the control plane: what is being worked on, and what is stuck.

- **Work:** open items, grouped by what needs attention
- **Shipped:** every delivered item, newest first, with its pull request and whether the deployment serves it
- **Insights:** Shipping pulse, Flow analytics, Validation and Releases, as tabs
- **Settings:** Test cases, Proof authority and Operator automation, as tabs

## The status sentence

Every card, and the top of every item view, carries one sentence derived from the item's first refusing gate — *Waiting for someone to pick this up*, *Waiting for review of PR #42*, *Stuck: needs a second Postgres instance*. An unrecognised reason reads as its step, never raw internal text.

**Stuck** means the item will not move until someone decides or fixes something:

- Recorded blocker
- Standing escalation or lead hold
- Merge conflict
- Pull request changing files outside its plan
- No available reviewer
- Proof that no longer counts

## Home page and item view

- **Heading** carries the open total (*Work 7*): the sum of the count row, shown nowhere else — the sidebar's *Work* entry is a name, not a count
- **Count row** is the one row of counts, the stages in work order; an empty stage is not drawn, and the row is absent when nothing is open; a lapsed claim sits under *Needs a worker* whatever the stored stage says; clicking a stage filters the lists, again clears; *Show times* adds the oldest item and the p50/p95 per drawn stage; delivered work never appears
- **Lists** show *Stuck* first, then *In progress* and *Needs a worker*, oldest first, *Not started* collapsed; only *Stuck* carries a count — items, not gate reasons; *Shipped this week* the last seven days
- **Board view** draws a column for every open stage, empty ones included, headed by the stage name alone
- **One source:** `homeNumbers` in `web/home-numbers.ts` returns one field per number drawn; `unit:home-numbers-reconcile`, `unit:work-page-single-count-row`, `unit:work-page-no-derived-totals` and `integration:work-page-density` hold the page to it
- **Item view** opens with the status sentence, owner, pull request and the one thing blocking progress
- **Steps** lists the gates in order
- **What must be true** lists each acceptance criterion once with one marker per proof: ✓ passed, ○ pending, × failed or withdrawn
- **More details** holds description, type, priority, policy and revision, worker and assignment, workspaces, coordination diagnosis, file overlaps, merge-queue position, review provider, raw gate reasons, proof details, bootstrap obligations, observed delivery, evidence with artifacts, history; an admin session gets an **Edit** menu for the review provider, a fresh review and requirement revisions.

## Candidate links and definitions

- **Work cards and the Ownership section** show `PR #N` and the whole 40-character candidate SHA, readable and copyable
- **With GitHub configured:** both become links built only from the configured repository identity plus the observed pull-request number and hexadecimal SHA, so candidate-authored values can never select a URL
- **Unconfigured or failing validation:** renders as selectable plain text
- **A technical word** carries a hover definition from one interface glossary; a test reads each default view as a newcomer does, failing on any abbreviation, proof name or commit shown without its definition

## Connection and keyboard behaviour

- **Access token:** verified before any work or status displays; a rejected token returns to the sign-in form with an error
- **Polling failures:** keep the last snapshot with a stale-data warning, retrying every five seconds
- **Snapshot:** informational; the server authorizes every mutation
- **The dashboard's 300-event display limit** never truncates the ledger
