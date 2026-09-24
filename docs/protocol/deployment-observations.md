<!-- page: Agent protocol | 10 | recording deployment-provider observations that feed flow analytics without moving a gate. -->
# Deployment observations

`POST /api/deployments` (`producer` or `admin`) records one provider observation:

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

`state` is `succeeded`, `failed` or `rolled_back`. Records are append-only and unique per provider, external ID and state; an identical repeat returns `duplicate`, a differing one is refused. They feed [flow analytics](../flow-analytics.md) and never move a gate.
