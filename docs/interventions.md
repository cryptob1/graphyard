<!-- page: Operate Graphyard | 12 | what counts as an intervention. -->
# Interventions as product feedback

Each time someone has to step in, the product failed to handle something. See **Shipped → Interventions**, `GET /api/interventions?window=7|30|90`, or `master status` under `interventions`.

## What counts

Kinds, read from typed ledger events: `rework`, `scope-widening` (a refused scope request widened by hand), `bypass`, `containment-settlement` (a fence not settled by its own supervisor), `session-nudge`, `escalation` (not auto-settled ones), `human-only-decision`. A coordinator or admin records a nudge:

```sh
curl -X POST "$GRAPHYARD_URL/api/interventions" -H "Authorization: Bearer $COORDINATOR_TOKEN" -H 'Idempotency-Key: …' \
  -d '{"kind":"session-nudge","work":"GY-98","blocked":"reviewer session showed no activity for 15 minutes","since":"2026-09-21T10:00:00Z","resolution":"re-prompted once"}'
```

The response reports `ratePerDelivery`, `total`, `open`, `waitedMs`, `byKind`, `byStage`, `trend`, `costliest` items and `patterns`. No figure is keyed by a person.

## Patterns become work

`GRAPHYARD_INTERVENTION_PATTERN_THRESHOLD` (3) of one kind at one stage within `GRAPHYARD_INTERVENTION_PATTERN_WINDOW_DAYS` (7) opens one priority-1 `bug` item per pattern. The periodic scan needs `GRAPHYARD_INTERVENTION_PATTERNS=1`; `POST /api/interventions/patterns` runs it now.

## Judgement about delivered work

```sh
curl -X POST "$GRAPHYARD_URL/api/judgements" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Idempotency-Key: …' \
  -d '{"work":"GY-81","verdict":"confusing","text":"The dashboard shows the queue position before review"}'
```

`verdict` is `confusing`, `wrong-for-user` or `not-good-enough`; name `work` and/or `page`. `POST /api/judgements/ID/work` turns one into a work item.
