<!-- page: Agent protocol | 1 | every work mutation. -->
# Work commands

All but `/healthz` need `Authorization: Bearer TOKEN` ([roles](../glossary.md#the-roles-at-a-glance)); mutations an `Idempotency-Key`, reused only for identical retries. Errors: `{ "error": "reason" }`; read a `409` refusal, never blindly retry.

`POST /api/work` ([example](../../examples/work.json)) requires `title`, `criteria`; optional `dependencies`, `exclusiveResources`, `plannedFiles`, `producerProofs` (producer-runnable `manual:` proofs). Others: `POST /api/work/KEY/COMMAND`:

- `requirements`: document, `expectedPolicyRevision`, `reason`; `admin` (operator agents: additively).
- `ready`, `unblock`: `{"reason"}` (operator agents add `expectedRevision`).
- `resolve`: `{"trigger","expectedRevision","reason"}`; human `admin`, or any `admin` with `"attestation":{"kind":"blocked"|"stopped-worker","epoch":N}` explaining a `lease-loss`.
- `rework`, `recover` (delivered quarantine): `admin`, `{"reason","previousWorkerStopped":true}`.
- `claim` `{}`; `heartbeat`, `release` `{"epoch":1}`; `blocked` `{"epoch":1,"reason"}` (null clears); `workspace` `{"epoch":1,"host","path","branch":"graphyard/gy-1-1"}`.
- `submit`: `{"epoch":1,"pr":123}`; `409` if a non-`plannedFiles` file [regresses shipped code](../coordination.md#refuse-candidates-that-revert-shipped-code-outside-their-scope) or an applied retro check fails.
- `deployment`: `{"sha","mergeSha","source":"endpoint","observedAt"}`; coordinator/admin, once, delivered work.
- `followups` `{findings,reason}` (master): records approval findings (`409` once closed); read `GET /api/work/KEY/followups`, `/api/followups?pr=N`. `promote` `{index}` (operator): finding → item, once ([follow-ups](../followups.md)); `triage` `{judgement}` (coordinator), `POST /api/followups/migrate` (once): [backlog](../master-agent.md#machine-filed-backlog).
- `POST /api/retro/synthesize` (coordinator/admin) drafts [retro artefacts](../operations-reference.md#retro-synthesis); `POST /api/retro/ID/approve|refuse` `{reason}`: an AI holder of `decision:approve`, never a human, drafter or recorder (`403`; `409` once judged).

No endpoint sets lifecycle state.
