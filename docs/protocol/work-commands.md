<!-- page: Agent protocol | 1 | every work mutation. -->
# Work commands

All but `/healthz` need `Authorization: Bearer TOKEN` ([roles](../glossary.md#the-roles-at-a-glance)); mutations an `Idempotency-Key`, reused only for identical retries (replaying the result). Errors: `{ "error": "reason" }`; a `409` coordination refusal is read, not blindly retried.

`POST /api/work` ([example](../../examples/work.json)): `title`, `criteria`; optionally `dependencies`, `exclusiveResources`, `plannedFiles`, `producerProofs` (producer-runnable `manual:` proofs). Others: `POST /api/work/KEY/COMMAND`:

- `requirements`: document, `expectedPolicyRevision`, `reason`; `admin` (operator agents additively).
- `ready`, `unblock`: `{"reason":…}` (operator agents add `expectedRevision`).
- `resolve`: `{"trigger":…, "expectedRevision":…, "reason":…}`; human `admin`, or any `admin` with `"attestation":{"kind":"blocked"|"stopped-worker","epoch":N}` explaining a `lease-loss`.
- `rework`, `recover` (delivered quarantine): `admin`, `{"reason":…, "previousWorkerStopped":true}`.
- `claim` `{}`; `heartbeat`, `release` `{"epoch":1}`; `blocked` `{"epoch":1,"reason":…}` (null clears); `workspace` `{"epoch":1,"host":…,"path":…,"branch":"graphyard/gy-1-1"}`.
- `submit`: `{"epoch":1,"pr":123}`; `409` if a non-`plannedFiles` file [regresses shipped code](../coordination.md#refuse-candidates-that-revert-shipped-code-outside-their-scope) or an applied retro check fails.
- `deployment`: `{"sha":…, "mergeSha":…, "source":"endpoint", "observedAt":…}`; coordinator/admin, delivered work, once.
- `followups` `{findings,reason}` (master): approval findings onto the item (or open legacy follow-up; `409` once closed); read `GET /api/work/KEY/followups`, `GET /api/followups?pr=N`. `promote` `{index}` (operator): finding → item, once ([follow-ups](../followups.md)); `triage` `{judgement}` (coordinator), `POST /api/followups/migrate` (once): [backlog](../master-agent.md#machine-filed-backlog).
- `POST /api/retro/synthesize` (coordinator/admin) drafts [retro artefacts](../operations-reference.md#retro-synthesis) as caller; `POST /api/retro/ID/approve|refuse` `{reason}` by its rules (`403`; `409` once judged).

No endpoint sets lifecycle state.
