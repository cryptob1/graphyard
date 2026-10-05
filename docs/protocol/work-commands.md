<!-- page: Agent protocol | 1 | every work mutation. -->
# Work commands

All but `/healthz` need `Authorization: Bearer TOKEN` ([roles](../glossary.md#the-roles-at-a-glance)); mutations an `Idempotency-Key`, reused only for identical retries. Errors: `{ "error": "reason" }`; a `409` refusal is read, not retried.

`POST /api/work` ([example](../../examples/work.json)): `title`, `criteria`; optionally `dependencies`, `exclusiveResources`, `plannedFiles`, `producerProofs` (producer-runnable `manual:` proofs). Others: `POST /api/work/KEY/COMMAND`:

- `requirements`: document, `expectedPolicyRevision`, `reason`; `admin` (operator agents additively).
- `ready`, `unblock`: `{"reason":…}` (operator agents add `expectedRevision`); `master unblock` retries a stale-revision refusal (≤3 writes) while the same blocker stands.
- `resolve`: `{"trigger":…, "expectedRevision":…, "reason":…}`; human `admin`, or any `admin` with `"attestation":{"kind":"blocked"|"stopped-worker","epoch":N}` explaining a `lease-loss`.
- `rework`, `recover` (delivered quarantine): `admin`, `{"reason":…, "previousWorkerStopped":true}`.
- `claim` `{}`; `heartbeat`, `release` `{"epoch":1}`; `release` may carry `"cause"` or `"failure":{"message":…}` (`workspace.failed`; an untouched claim keeps its epoch); `blocked` `{"epoch":1,"reason":…,"partialWork":…}` (a reason releases; null clears); `blocker-probe` (coordinator; a `pass` clears a routine [blocker](leases.md#blocked-work-unblocks-itself)); `workspace` `{"epoch":1,"host":…,"path":…,"branch":"graphyard/gy-1-1"}`, optional `preserved` (`workspace.preserved`).
- `submit`: `{"epoch":1,"pr":123}`; `409` if a non-`plannedFiles` file [regresses shipped code](../coordination.md#refuse-candidates-that-revert-shipped-code-outside-their-scope) or an applied retro check fails.
- `deployment`: `{"sha":…, "mergeSha":…, "source":"endpoint", "observedAt":…}`; coordinator/admin, delivered work, once.
- `triage` `{judgement}` (coordinator): [backlog](../master-agent.md#machine-filed-backlog); review follow-ups are never filed.
- `POST /api/retro/synthesize` (coordinator/admin) drafts [retro artefacts](../operations-reference.md#retro-synthesis) as caller; `POST /api/retro/ID/approve|refuse` `{reason}` by its rules (`403`; `409` once judged).

No endpoint sets lifecycle state.

## Other commands and routes

`graphyard help` describes every command; also: `handoff GY-N`, `human-requests`, `rereview GY-N [EPOCH]`, `scenarios`, `scenario file.json`, `master guide|autonomy|decisions|withdraw|close|context|refuse|principals`, `db status|backup|verify|restore`, `grants history`, `delivery observations`, `operator-agent list|setup|configure|rotate|revoke`, `runner account-digest|adapters`.

Further routes: executor `/api/actions`, `/api/actions/claim`; worker pull `/api/assignments/claim`; fleet `/api/agent-registry`, `/api/agent-registry/apply|select|document|history|connect|connect/host-key|connect/hosts|connect/providers|connect/requests`; validation `/api/validation/analytics|capacity|definitions|artifacts|artifacts/migrate|replay|replays|reuse|collection-authority|collection-heartbeat|cancel|settle|retry`; delivery `/api/delivery/observations|select|sweep`; direct merges `/api/direct-merges`, `/api/direct-merges/on|off`; and `/api/events/stats`, `/api/human-requests`, `/api/intake`, `/api/interventions/patterns`, `/api/judgements`, `/api/operator-agents`, `/api/principals`, `/api/production-environment`, `/api/scenarios`.

Pattern routes: `GET /api/attribution/work/ID`, `/api/attribution/manifest/ID/N`, `/api/validation/attempt/ID`, `/api/validation/candidate/ID`, `/api/work/ID/context`, `/api/work/ID/decisions`; `POST /api/work/ID/close|closed-question|lead-ruling|merge-acquire`, `/api/agent-registry/runtimes|models|accounts|roles[/NAME/remove|quota]`, `/api/agent-registry/sessions/ID/end`, `/api/agent-registry/connect/ID/claim|progress|result|cancel|answer`, `/api/operator-agents/NAME/configure|rotate|revoke`.
