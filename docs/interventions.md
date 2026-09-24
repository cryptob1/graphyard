<!-- page: Operate Graphyard | 12 | every operator intervention as product feedback: what counts, the rate per delivery, how a pattern becomes work, and how to record judgement about delivered work. -->
# Interventions as product feedback

Every time a person or coordinator has to step in, the product failed to handle something itself. Read the report on **Shipped → Interventions**, `GET /api/interventions`, or `graphyard master status` under `interventions`.

## What counts as an intervention

Each signal has a kind, what was blocked, how long it waited, the item and stage, and what resolved it, with the ledger rows it came from (`src/interventions.ts`).

| Kind | Read from |
| --- | --- |
| `rework` | `decision.requested` → `rework` |
| `scope-widening` | A refused `autoscope` widened by `requirements` (loop-approved requests do not count) |
| `bypass` | A merge outside the guarded path: `merge.operator-authorized` / `merge.reconciled` |
| `containment-settlement` | A fence lowered by `autosettle`, `recover` or `rework` instead of the worker's supervisor |
| `session-nudge` | Recorded explicitly (below) |
| `escalation` | `escalation.resolved`, or `blocked` → `unblock` (auto-settled ones do not count) |
| `human-only-decision` | `human.requested` → `human.answered` |

A coordinator or admin records a hand nudge:

```sh
curl -X POST "$GRAPHYARD_URL/api/interventions" -H "Authorization: Bearer $COORDINATOR_TOKEN" -H 'Idempotency-Key: …' \
  -d '{"kind":"session-nudge","work":"GY-98","blocked":"reviewer session graphyard-reviewer-1 showed no activity for 15 minutes","since":"2026-09-21T10:00:00Z","resolution":"re-prompted once with its own request"}'
```

## What the rate means

`GET /api/interventions?window=7|30|90` reports `ratePerDelivery` (interventions ÷ deliveries; `null` with no deliveries), `total`, `open`, `waitedMs`, `byKind`, `byStage`, `trend`, `costliest` items, `patterns`, `judgements` and the signals themselves (`?kind=`, `?stage=`, `?work=GY-N`). No figure is keyed by the person who intervened.

## How a pattern becomes work

When one kind at one stage reaches `GRAPHYARD_INTERVENTION_PATTERN_THRESHOLD` (default 3) within `GRAPHYARD_INTERVENTION_PATTERN_WINDOW_DAYS` (default 7), the control plane opens a priority-1 `bug` item linking the instances in `origin.pattern`, once per pattern. The periodic scan runs only with `GRAPHYARD_INTERVENTION_PATTERNS=1`; `POST /api/interventions/patterns` (coordinator) runs it now. `master status` flags a crossed pattern with no item yet.

## Recording judgement about delivered work

An admin, coordinator or operator agent records judgement against a delivered item or a page:

```sh
curl -X POST "$GRAPHYARD_URL/api/judgements" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Idempotency-Key: …' \
  -d '{"work":"GY-81","verdict":"confusing","text":"The dashboard shows the merge queue position before the item is reviewed"}'
```

`verdict` is `confusing`, `wrong-for-user` or `not-good-enough`; name `work`, `page` or both. `POST /api/judgements/ID/work` (or **Turn into an item**) opens one work item per judgement, optionally shaped by `title`, `criteria`, `plannedFiles` and `priority`.
