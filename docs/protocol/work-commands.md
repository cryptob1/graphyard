<!-- page: Agent protocol | 1 | every work mutation. -->
# Work commands

All but `/healthz` need `Authorization: Bearer TOKEN` ([roles](../glossary.md#the-roles-at-a-glance)); mutations an `Idempotency-Key`, reused only for identical retries. Errors: `{ "error": "reason" }`; a `409` coordination refusal is read, not blindly retried.

`POST /api/work` ([example](../../examples/work.json)): `title`, `criteria`; optionally `dependencies`, `exclusiveResources`, `plannedFiles`, `producerProofs` (producer-runnable `manual:` proofs). Others: `POST /api/work/KEY/COMMAND`:

- `requirements`: document, `expectedPolicyRevision`, `reason`; `admin` (operator agents additively).
- `ready`, `unblock`: `{"reason":…}` (operator agents add `expectedRevision`); `master unblock` retries a stale-revision refusal (≤3 writes) while the same blocker stands.
- `resolve`: `{"trigger":…, "expectedRevision":…, "reason":…}`; human `admin`, or any `admin` with `"attestation":{"kind":"blocked"|"stopped-worker","epoch":N}` explaining a `lease-loss`.
- `rework`, `recover` (delivered quarantine): `admin`, `{"reason":…, "previousWorkerStopped":true}`.
- `claim` `{}`; `heartbeat`, `release` `{"epoch":1}`; `blocked` `{"epoch":1,"reason":…}` (null clears); `workspace` `{"epoch":1,"host":…,"path":…,"branch":"graphyard/gy-1-1"}`.
- `submit`: `{"epoch":1,"pr":123}`; `409` if a non-`plannedFiles` file [regresses shipped code](../coordination.md#refuse-candidates-that-revert-shipped-code-outside-their-scope) or an applied retro check fails.
- `deployment`: `{"sha":…, "mergeSha":…, "source":"endpoint", "observedAt":…}`; coordinator/admin, delivered work, once.
- `followups` `{findings,reason}` (master): findings onto item (or open follow-up), held until ship ({ship:true}); read `GET /api/work/KEY/followups`, `GET /api/followups?pr=N`. `promote` `{index}` (operator): finding → item, once ([follow-ups](../followups.md)); `triage` `{judgement}` (coordinator), `POST /api/followups/migrate` (once): [backlog](../master-agent.md#machine-filed-backlog).
- `POST /api/retro/synthesize` (coordinator/admin) drafts [retro artefacts](../operations-reference.md#retro-synthesis) as caller; `POST /api/retro/ID/approve|refuse` `{reason}` by its rules (`403`; `409` once judged).

No endpoint sets lifecycle state.

## Other commands and routes

`graphyard help` describes every command; also: `handoff GY-N` (workspace, supervisor command), `human-requests`, `rereview GY-N [EPOCH]`, `scenarios`, `master guide`, `master autonomy`, `master decisions GY-N`, `master withdraw GY-N DECISION REASON`.

Further routes: executor actions `/api/actions`, `/api/actions/claim`; worker pull `/api/assignments/claim`; fleet `/api/agent-registry`, `/api/agent-registry/apply`, `/api/agent-registry/select`, `/api/agent-registry/document`, `/api/agent-registry/history`, `/api/agent-registry/connect`, `/api/agent-registry/connect/host-key`, `/api/agent-registry/connect/hosts`, `/api/agent-registry/connect/providers`, `/api/agent-registry/connect/requests`; validation `/api/validation/analytics`, `/api/validation/capacity`, `/api/validation/definitions`, `/api/validation/artifacts`, `/api/validation/artifacts/migrate`, `/api/validation/replay`, `/api/validation/replays`, `/api/validation/reuse`; and `/api/delivery/observations`, `/api/direct-merges`, `/api/events/stats`, `/api/human-requests`, `/api/intake`, `/api/interventions/patterns`, `/api/judgements`, `/api/operator-agents`, `/api/principals`, `/api/production-environment`, `/api/scenarios`.

Pattern routes: `GET /api/attribution/work/ID`, `/api/attribution/manifest/ID/N`, `/api/validation/attempt/ID`, `/api/validation/candidate/ID`, `/api/work/ID/context`, `/api/work/ID/decisions`; `POST /api/work/ID/close|closed-question|lead-ruling|merge-acquire`, `/api/agent-registry/runtimes|models|accounts|roles[/NAME/remove|quota]`, `/api/agent-registry/sessions/ID/end`, `/api/agent-registry/connect/ID/claim|progress|result|cancel|answer`, `/api/operator-agents/NAME/configure|rotate|revoke`.
