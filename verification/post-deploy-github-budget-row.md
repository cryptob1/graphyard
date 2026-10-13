# GY-1725: github-budget attention row on release ba607f8a809e

Verifies GY-1700 AC-3 (merge a14965e4ad9a) on the serving release ba607f8a809e, recorded deployed 2026-10-12T07:33:47Z. Window: 2026-10-12T07:34Z to 2026-10-13T07:34Z (24h), elapsed.

## What the row is

`webhookAttention` (src/cli/github-budget-attention.ts) raises the github-budget row only when `webhookState` is `failing` or `unverified`: no delivery for an hour while pull requests are open, and GitHub's delivery log shows unanswered attempts in that gap (or cannot be read). Its remedy text says "a delivery that arrives clears this". So a delivery arriving is the clearing event, and the row re-fires only if an hour passes with no delivery and failed or unread attempts.

## Clearing on a delivery (on the serving release)

- 2026-10-13T07:52:25Z, `graphyard status` webhooks: `lastDeliveryAt` 2026-10-13T07:52:25.581Z, `lastHour` 706 deliveries, `state: delivering`, `failedAttempts` 0, `deliveryLogError` null, `openPullRequests` 4. Deliveries are arriving on the serving release and the state that raises the row is not the state read.
- 2026-10-12T07:37Z (3 minutes after deploy): no github-budget row with 42 pull requests open. The row that GY-1700 targeted was already clear once the release served deliveries.

I did not observe a raised row on this release, so there was no raise-then-clear transition to witness; the row was never present after the deploy. The delivery that clears it is the continuous stream above.

The raise-then-clear transition itself is pinned by `integration:webhook-liveness-visible` (tests/github-rate-budget.test.ts:512): `webhookAttention` raises the row for a silent hour with pull requests open (line 521), then returns `[]` once a delivery arrives (line 533). The same file's `unit:webhook-attention-fires-on-failed-attempts` and `unit:webhook-attention-202-only-stays-silent` pin the raise and no-raise sides. A live raise would need the App webhook to fail for an hour, which this item must not induce on the serving release, and the App delivery log (`GET /app/hook/deliveries`) needs the App JWT, which a worker does not hold. So the live transition is unobserved and stated as such; the criterion's clearing clause rests on the test above plus the delivering state read on the serving release.

## No re-fire across the window

Interval-wide evidence of delivery activity across 2026-10-12T07:34Z..2026-10-13T07:34Z, from GitHub's side (each is a webhook delivery to the control plane):

- 43 merge commits on main (first 2026-10-12T07:49:44Z, last 2026-10-13T07:25:08Z).
- 448 timestamps of issue/PR comments, review comments, commits and PR creations (first 07:34:11Z, last 2026-10-13T07:29:32Z). The longest span with none visible through those endpoints is 304.7 minutes, 2026-10-12T17:46:14Z to 22:50:58Z (overnight); checks, pushes and review events add deliveries not counted here.
- Readings of `master status` attentionItems: 2026-10-12T07:37Z (42 open PRs), 16:00:02Z (30 open), 2026-10-13T07:44Z (36 rows, 45 open PRs). None has kind github-budget; the pipeline doctor boards at roughly 15-minute intervals through the window (53 findings recorded on GY-1725 between 08:03Z and 05:19Z) each read the board and none reports a github-budget row.

Limit: no record stores the attention rows themselves over time, so the absence between readings rests on the delivery stream above and the row's own rule, not on a stored row history. In the 5h overnight span with no GitHub-visible comments or commits, a quiet hour raises nothing by that rule unless GitHub attempted and failed deliveries, and the 07:44Z and 07:52Z reads show zero failed attempts and a delivering state.

Result: the github-budget row was clear at the start, mid-window and close of the 24h window, deliveries kept arriving on ba607f8a809e with pull requests open, and the row did not re-fire. No code change.
