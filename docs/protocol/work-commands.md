<!-- page: Agent protocol | 1 | every work mutation. -->
# Work commands

All but `/healthz` need `Authorization: Bearer TOKEN` ([roles](../glossary.md#the-roles-at-a-glance)); mutations an `Idempotency-Key`, reused only for identical retries. Errors: `{ "error": "reason" }`; read a `409` refusal, never blindly retry.

`POST /api/work` ([example](../../examples/work.json)) requires `title`, `criteria`; optional `dependencies`, `exclusiveResources`, `plannedFiles`, `producerProofs` (producer-runnable `manual:` proofs). Others: `POST /api/work/KEY/COMMAND`:

- `requirements`: document, `expectedPolicyRevision`, `reason`; `admin` (operator agents: additively).
- `ready`, `unblock`: `{"reason"}` (operator agents add `expectedRevision`); `master unblock` retries stale-revision refusals (three writes) while the blocker stands.
- `resolve`: `{"trigger","expectedRevision","reason"}`; human `admin`, or any `admin` with `"attestation":{"kind":"blocked"|"stopped-worker","epoch":N}` explaining a `lease-loss`.
- `rework`, `recover` (delivered quarantine): `admin`, `{"reason","previousWorkerStopped":true}`.
- `claim` `{}`; `heartbeat`, `release` `{"epoch":1}` (`release` may carry `"cause"`, as a supervisor whose session is gone does, leaving no blocker); `blocked` `{"epoch":1,"reason","partialWork"}`: a reason ends the attempt and releases the lease; null clears while leased; `workspace` `{"epoch":1,"host","path","branch":"graphyard/gy-1-1"}`.
- `blocker-probe` `{blocker,class,probe,result,detail,nextAt}`: coordinator; a `pass` clears a routine blocker ([classes](leases.md#blocked-work-unblocks-itself)).
- `submit`: `{"epoch":1,"pr":123}`; `409` if a non-`plannedFiles` file [regresses shipped code](../coordination.md#refuse-candidates-that-revert-shipped-code-outside-their-scope) or an applied retro check fails.
- `deployment`: `{"sha","mergeSha","source":"endpoint","observedAt"}`; coordinator/admin, once, delivered work.
- `followups` `{findings,reason}` (master): holds an approved item's findings until it ships (`parent:true` appends to its open follow-up item; `409` once closed); `{ship:true,reason}` files them as one item. `promote` `{index}` (operator): finding → item, once ([follow-ups](../followups.md)); `triage` `{judgement}` (coordinator), `POST /api/followups/migrate` (once): [backlog](../master-agent.md#machine-filed-backlog).
- `POST /api/retro/synthesize` (coordinator/admin) drafts [retro artefacts](../operations-reference.md#retro-synthesis); `POST /api/retro/ID/approve|refuse` `{reason}`: an AI holder of `decision:approve`, never a human, drafter or recorder (`403`; `409` once judged).

No endpoint sets lifecycle state.
