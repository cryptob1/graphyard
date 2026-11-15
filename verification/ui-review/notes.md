# Dashboard UI review (GY-3321)

Screenshots of every dashboard page at 1440 px and 390 px, on a control plane seeded with three items
(two Up next, one Backlog): `before/` is the base tip (`SECTION--TAB-WIDTH.jpg`), `after/` has the shared
page shell on every page the router lists (`PAGE-WIDTH.jpg`, and `PAGE-WIDTH-empty.jpg` with no data),
written by `UI_REVIEW_SHOTS=1 npm run test:browser -- browser-tests/ui-shell-all-pages.spec.ts` (GY-3322).

## The shell

One page heading (`.page-heading`): the `h1` title, the page's primary fact under it (`.page-fact`, the
largest text after the title), and the page's one primary action top right (`.page-actions`; it wraps
under the fact on a phone). One card (`.panel`) with one section heading (`.panel h2`); Work's groups are
cards whose rows run edge to edge. One table class (`.sessions-table`; `.figures` keeps a table of numbers a
table on a phone). One empty state (`.panel.empty`, `EmptyState` in web/components/page-layout.tsx). The content uses the full width
beside the sidebar.

## Applied in this item

- Work: the eye landed on the green tagline and "0 shipped today"; the summary sentence that answers the
  page was the smallest text, under both. Groups had their own card border and heading rules.
- Work item: a 26 px title in its own `.item-head`, smaller than every other page title; the status
  sentence sat inside a tinted box below; "Release to ready" was at the bottom of that box, and no action
  was ever top right.

## Remaining pages, as found before the follow-up item (GY-3322)

- Now: title, then "Your items · 0" as the fact; the empty state is a tall dashed box with centred text.
- Master: the heading has no fact or action; a refusal line in tiny type sits above a full-height black
  terminal.
- Product: the empty brief is three tiny lines and a stray full stop in an empty page.
- Workers: tiny 12 px empty state and roles line; the open/ended counts are the only fact; Ended and By
  account folds float in empty space.
- Costs: four cost tiles butt straight against the description and the price sheet card with no spacing
  scale; an empty price sheet still draws its header row.
- Shipped: a title and one tiny sentence, the rest of the screen empty; no fact, no action.
- Tests: the description runs the full width as two long lines; three rows of filter chips come before
  the 0-cases fact; "Define test cases" wraps into a two-line button.
- Test cases: a breadcrumb and rule push the title down; two primary buttons ("New test case" and
  "Define the first test case"); the empty state has its own dashed-box style.
- Agents: a breadcrumb and rule above the title push it down; two primary buttons ("Open the first-run
  Setup checklist", "Connect an account"); section headings are a different style from Work's.
- Setup: the fact ("3 of 3 steps left") is small grey text; the checklist is a plain numbered list with a
  primary button per step, so three buttons compete; no cards.
- Help (How Graphyard works): a 920 px column leaves a third of the wide page empty; its own table and
  card styles (`.guide-table`, `.guide-card`).
- Delivery: no page title at all, only a tiny breadcrumb above a rule; its sections already use `.panel`.
- Needs you, Releases and Operator automation show only with matching data or configuration and were not
  reachable on the seeded plane; apply the same shell.

## Applied in GY-3322

Every page the router lists (Work, Now, Needs you, Shipped, Workers, Master, Releases, Tests, Test cases,
Product, Costs, Agents, Setup, Operator automation, How Graphyard works, Delivery) opens by its address
(`#costs`) and is built from `PageHeader` (title, primary fact, actions top right), `PageSection` (card and
section heading) and `EmptyState`. Breadcrumbs, eyebrows, `.section-title`, `.master-heading`, `.guide-table`,
`.guide-lead`, `.cost-table`, `.flow-data`, `.compact-table`, the old dashed `.empty` and the scenario card's own
box are gone. Agents has one primary action (Connect an account; the Setup checklist is a link beside it);
Costs shows the empty state rather than four $0.00 tiles and an empty price sheet; Help uses the full width.
e2e:ui-shell-all-pages walks every route at both widths, seeded and empty.

## Rework verification (epoch 3)

Synced onto `origin/main` at `0fe82c9c5012`; the prior implementation already contains that base.
The master's rework instruction attributes the create-work-one-box timeout to concurrent trial load
and requests resubmission without changing that test or its timeout. Both remain unchanged.
`npm run build` passes. The affected run and focused browser retry encountered local environment
and host-load failures (recorded in this commit); they do not establish a fresh browser pass.
The existing screenshots and bound proof remain intact for the independent trial of the new head.
