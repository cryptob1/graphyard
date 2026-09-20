<!-- page: Operate Graphyard | 3 | what each number and marker means. -->
# Reading the dashboard

For anyone looking at the control plane: what is being worked on, and what is stuck.

- **Work:** The home page: open items, grouped by what needs attention
- **Shipped:** Every delivered item, newest first, with its pull request and whether the deployment serves it
- **Insights:** Shipping pulse, Flow analytics, Validation and Releases, as tabs
- **Settings:** Test cases, Proof authority and Operator automation, as tabs

## The status sentence

Every card, and the top of every item view, carries one sentence derived from the item's first refusing gate — *Waiting for someone to pick this up*, *Alex is building it — no pull request yet*, *Waiting for review of PR #42*, *Stuck: needs a second Postgres instance*. An unrecognised reason reads as its step, never as raw internal text. **Stuck** means the item will not move until someone decides or fixes something: a recorded blocker, a standing escalation or lead hold, a merge conflict, a pull request changing files outside its plan, no available reviewer, or a proof that no longer counts. Everything else is waiting its turn.

## Home page and item view

- Tiles count open items only — *Open*, *Being built*, *Need a worker*, *Stuck*; delivered work never appears in one.
- The stage strip splits open items by stage and adds up to *Open*; an item whose claim lapsed sits under *Needs a worker* whatever its stored stage says, and *Show times* adds the oldest item and the p50/p95 time per stage.
- Lists show *Stuck* first, then *In progress* and *Needs a worker*, oldest first, with *Not started* collapsed; *Board view* arranges the same items in stage columns, and *Shipped this week* lists the last seven days.
- The item view opens with the status sentence, the owner, the pull request and the one thing blocking progress. **Steps** lists the gates in order; **What must be true** lists each acceptance criterion once with one marker per proof: ✓ passed, ○ pending, × failed or withdrawn.
- **More details** holds the description, type, priority, policy and revision, worker ID and assignment, workspaces, coordination diagnosis, file overlaps, merge-queue position, review provider, raw gate reasons, proof details, bootstrap obligations, observed delivery, evidence with its artifacts, and history. Admin sessions also get an **Edit** menu for switching the review provider, requesting a fresh provider review and revising requirements.

## Candidate links and definitions

Work cards and the Ownership section show `PR #N` and the whole 40-character candidate SHA, so the exact commit the gates decided on can be read and copied. When GitHub is configured both are links built only from the configured repository identity plus the observed numeric pull-request number and full hexadecimal SHA, so candidate-authored values can never select a URL; they open in a new tab with accessible names beginning with the visible reference (`PR #12, open pull request for GY-7 in GitHub`), and activating one does not change selection. Without a configured repository, or when a reference fails validation, it renders as selectable plain text. A technical word carries a dotted underline and a hover definition from one interface glossary; a test reads each default view as a newcomer does and fails on any abbreviation, proof name or commit shown without its definition.

## Connection and keyboard behaviour

- The access token is verified before any work or integration status is displayed; pasted whitespace is trimmed, and a rejected or revoked token returns to the sign-in form with an explicit error, clearing loaded work.
- During initial verification, unknown counts are not shown as zero and unknown GitHub connectivity is not reported as disconnected.
- After a successful load, polling failures keep the last snapshot with a stale-data warning and the last-success timestamp; polling retries every five seconds and times out after fifteen. The snapshot is informational — the server still authorizes every mutation.
- Signing out clears the token and invalidates pending mutations locally; responses from a previous sign-in cannot restore its data, though an accepted write stays in the ledger.
- Dialogs move focus inside when opened, keep Tab and Shift-Tab inside, close on Escape and return focus to the opening control. History shows 20 entries at a time in a keyboard-accessible scroll area, grouping consecutive GitHub observations from one actor with a count and time range — grouping observation activity, not claiming identical payloads, and it can be turned off to inspect individual rows; **Show more history** changes the visible count, refreshes preserve the choice, and opening another item resets it.
- The dashboard receives the latest 300 events per item; its display limits never truncate the ledger.

