<!-- page: Agent protocol | 10 | recording deployment-provider observations that feed flow analytics without moving a gate. -->
# Deployment observations

`POST /api/deployments` records one deployment-provider observation. It requires a `producer`
credential or the human operator's `admin` credential; workers cannot record one.

```json
{
  "provider": "railway",
  "externalId": "deployment-1234",
  "environment": "production",
  "sha": "cccccccccccccccccccccccccccccccccccccccc",
  "containedMergeShas": ["dddddddddddddddddddddddddddddddddddddddd"],
  "state": "succeeded",
  "startedAt": "2026-09-17T05:04:00.000Z",
  "finishedAt": "2026-09-17T05:05:30.000Z"
}
```

`state` is `succeeded`, `failed`, or `rolled_back`. `sha` is the provider's exact deployed
artifact identity and `containedMergeShas` lists the independently verified merge commits it
contains; the artifact need not equal any single merge commit. Records are append-only and
unique per provider, external ID, and state; a repeat that replays every immutable field
returns `duplicate`, and one that differs is refused. Deployment observations feed deployment
frequency, latency, failure, and rollback in [flow analytics](../flow-analytics.md). They are
not a lifecycle-state endpoint: they never move a gate.
