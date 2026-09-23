<!-- page: Operate Graphyard | 12 | every operator intervention as product feedback: what counts, the rate per delivery, how a pattern becomes work, and how to record judgement about delivered work. -->
# Interventions as product feedback

Graphyard measures correctness — gates, proofs, reviews, CI — and it measures latency. Neither says whether it is a good product to use. The one signal that does is already flowing through it: **every time a person or a coordinator has to step in, the product failed to handle something itself.** Interventions are the highest-fidelity feedback the system has, because each one is an admission that the product asked a human to do its job. This page states the model for an adopting operator: what counts as an intervention, what the rate means, how a recurring one becomes work without anybody noticing it, and how to record your own judgement about what shipped.

Open the report from the dashboard (**Shipped → Interventions**), read it from `GET /api/interventions`, or find it in `graphyard master status` under `interventions`.

## What counts as an intervention

An intervention is a typed signal, never a sentence in an item's history. Each carries the same fields: the **kind**, **what was blocked**, **how long it waited** (from the moment the product needed somebody to the moment they acted), **which item and stage**, and **what resolved it** — the identity that acted and its recorded reason — plus the ledger rows it was read from, so every figure traces to history.

| Kind | What it means | Read from |
| --- | --- | --- |
| `rework` | A candidate was sent back for reassignment: a two-party rework decision, or an operator's direct `rework`. The wait runs from the decision request (or the worker's blocked report) to the applied rework. | `decision.requested` → `rework` |
| `scope-widening` | A worker asked for files outside `plannedFiles`, the loop refused because the item did not imply them, and an operator widened the scope; or an operator widened scope unasked. A request the loop approves on its own is **not** an intervention: the product handled it. | `scope` → `autoscope` (refused) → `requirements` |
| `bypass` | A merge outside the guarded path: the record refused the reconciliation and an operator owned the delivery, or a reconciled delivery. The wait runs from the provider's merge instant to the delivery. | `merge.reconciliation.refused` → `merge.operator-authorized` / `merge.reconciled` |
| `containment-settlement` | A containment fence that somebody other than the worker's own supervisor had to lower: a coordinator's verified-dead settlement, a delivered item's recovery, or a stopped-worker rework that discards it. A fence the worker settles itself is not an intervention. The wait runs from the lost lease under the fence. | `quarantine` → `autosettle` / `recover` / `rework` |
| `session-nudge` | A session that took up neither its request nor the loop's re-prompt and was nudged by hand. Recorded explicitly (below); the ledger cannot see a keystroke in Herdr. | `intervention.recorded` |
| `escalation` | A standing escalation resolved by a declared human or an approved `resolve` decision (its `trigger` names the concern), or a worker's blocked report cleared by `unblock`. An escalation the control plane auto-settles is not an intervention. | `escalation.resolved`; `blocked` → `unblock` |
| `human-only-decision` | A parked item: goals and priorities, money or accounts, credentials for people. The wait is the request's own, as the answer records it. | `human.requested` → `human.answered` |

An **open** intervention is one still waiting — a refused scope request no operator has decided, a standing escalation, a parked item — and is measured up to the report's own instant. A wait the fold saw opened but whose item no longer carries it was met by a command the fold does not read; it is not reported as waiting.

The signals are read from the ledger's own typed events by `src/interventions.ts`, never from prose, so an intervention can be neither invented nor edited: what the record says happened is what the report counts. Sessions that intervene by hand record the signal with the same fields:

```sh
curl -X POST "$GRAPHYARD_URL/api/interventions" -H "Authorization: Bearer $COORDINATOR_TOKEN" -H 'Idempotency-Key: …' \
  -d '{"kind":"session-nudge","work":"GY-98","blocked":"reviewer session graphyard-reviewer-1 showed no activity for 15 minutes","since":"2026-09-21T10:00:00Z","resolution":"re-prompted once with its own request"}'
```

`since` is when the product first needed the intervention; `resolution` is what the session did. A coordinator or an admin may record one; a worker may not.

## What the rate means

`GET /api/interventions?window=7|30|90` (default 30) reports over a window ending now:

- **`ratePerDelivery`** — interventions needed in the window divided by items delivered in it: how much hand work each shipped change cost. `null` while nothing was delivered. A product that handles its own cases drives this toward zero; a rising rate with steady throughput means the product is asking people for more.
- **`total`, `open`, `waitedMs`** — the signals in the window, how many still wait, and the attention they cost in total.
- **`byKind`, `byStage`, `byKindAndStage`** — where people stepped in: the kind is what the intervener did, the stage is where the item stood when it was needed.
- **`trend`** — one bucket per day (7-day window) or per week, oldest first, with interventions, deliveries and attention per bucket.
- **`costliest`** — the items that cost the most attention, most first, with their kinds.
- **`patterns`** — every kind-at-stage pair against the recurrence rule below, and the item it opened.
- **`judgements`** — the operator's judgement about delivered work (below).
- **`interventions`** — the signals themselves, newest first. `?kind=`, `?stage=` and `?work=GY-N` narrow the read; `ledger.truncated` says when the reading folded fewer rows than the ledger holds.

The report answers "what is this product making people do by hand, and where". It is not a measure of the people who stepped in: no figure is keyed by an intervener, and the costliest list names items, never identities.

## How a pattern becomes work

A recurring intervention becomes work without a human noticing it. When interventions of one kind at one stage cross a configured threshold in a window, the control plane opens a work item itself — type `bug`, priority 1, actor `graphyard` — naming the pattern, its frequency, the items it affected and the attention it cost, and linking the instances as evidence: the item's `origin.pattern` carries each instance's id, item, wait and the ledger rows it was read from, and the description lists them. The item asks for the cause to be found and removed, with one `manual:` proof for the review that says so.

- The rule is `GRAPHYARD_INTERVENTION_PATTERN_THRESHOLD` (default 3) in `GRAPHYARD_INTERVENTION_PATTERN_WINDOW_DAYS` (default 7), read at server start and reported as `policy`.
- The server checks once a minute (`openPatternItems` in the reconciliation tick); `POST /api/interventions/patterns` with a coordinator credential runs the check now and answers with what it opened.
- The item is opened **once**: while an item for the pattern is open (any stage but `done`), nothing is opened again, however many more instances arrive. Instances an item already links never count toward a second item, so a delivered pattern item is followed by a new one only when new instances cross the threshold on their own.
- A pattern counts as crossed while an item stands for it or while its unlinked instances reach the threshold; once the item is delivered, the instances it linked no longer cross anything, so the report, the dashboard and `master status` stop naming the pattern until new instances cross on their own.
- `master status` lists the crossed patterns under `interventions.patterns` and raises attention only for a pattern the server has not yet opened an item for.

The opened item is ordinary backlog: the master releases it, the loop dispatches it, and it earns its gates like any other. Its `origin` is the audit of why it exists.

## Recording judgement about delivered work

Correctness gates say nothing about whether the thing delivered is good. The operator's judgement — that something is confusing, wrong for its user, or not good enough — is first-class input with the same standing as a failed gate, recorded against the item or the page it concerns rather than typed into a chat:

```sh
curl -X POST "$GRAPHYARD_URL/api/judgements" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Idempotency-Key: …' \
  -d '{"work":"GY-81","verdict":"confusing","text":"The dashboard shows the merge queue position before the item is reviewed"}'
curl -X POST "$GRAPHYARD_URL/api/judgements" … -d '{"page":"docs/dashboard.md","verdict":"not-good-enough","text":"The page never says what a proof is"}'
```

`verdict` is `confusing`, `wrong-for-user` or `not-good-enough`; `work` names a delivered item by key, `page` a docs path, a dashboard view or a URL, and a judgement names at least one. An admin, a coordinator or an operator agent may record one. The dashboard's Interventions page has the same form beside the delivered list.

The judgement appears in the report at once and becomes a work item on request — `POST /api/judgements/ID/work` with an admin or operator-agent credential, or **Turn into an item** on the dashboard — carrying the judgement's own words as its description and `origin.judgement` as its audit. Pass `title`, `criteria`, `plannedFiles` or `priority` to shape the item; without them it asks for the judgement to be addressed and reviewed by hand. One item per judgement: a second request returns the first. From there it is backlog like any other item, released and dispatched by the loop.

## Reading the report from the CLI

`graphyard master status` carries the last seven days under `interventions`: the window, deliveries, total and open counts, attention, the rate per delivery, the breakdown by kind and stage, the five costliest items, the crossed patterns with their items, the judgement count, and what the ledger reading covered. A pattern the server has not opened an item for is an attention item there, with the request that opens it now.
