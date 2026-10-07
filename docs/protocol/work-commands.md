<!-- page: Agent protocol | 1 | work mutations. -->
# Work commands

All but `/healthz` need `Authorization: Bearer TOKEN` ([roles](../glossary.md#the-roles-at-a-glance)); mutations an `Idempotency-Key`, reused only for identical retries. Errors: `{ "error": "reason" }`; a `409` refusal is read, not retried.

`POST /api/work` ([example](../../examples/work.json)): `title`, `criteria`; optionally `dependencies`, `exclusiveResources`, `plannedFiles`, `split` ([decomposition](#splitting-an-item) opt-out/in), `producerProofs` (producer-runnable `manual:` proofs); `parent`/`children` are set only by a split. Others: `POST /api/work/KEY/COMMAND`:

- `requirements`: document, `expectedPolicyRevision`, `reason`; `admin` (operator agents additively); `split` kept when omitted; a stale revision is refused (`Policy revision changed`).
- `decomposition` (coordinator): `{event:"started"|"decided"|"failed",…}`; `decided` makes the [split](#splitting-an-item).
- `ready`, `unblock`: `{"reason":…}` (operator agents add `expectedRevision`; `master unblock` retries a stale revision ≤3 times). A two-party `release`, `unblock` or revision-pinned `close` decision still applies when the item moved only in loop bookkeeping; any other move settles it `stale`.
- `resolve`: `{"trigger":…, "expectedRevision":…, "reason":…}`; human `admin`, or any `admin` with `"attestation":{"kind":"blocked"|"stopped-worker","epoch":N}` explaining a `lease-loss`.
- `rework`, `recover` (delivered quarantine): `admin`, `{"reason":…, "previousWorkerStopped":true}`.
- `repair` `{"reason":…}` (coordinator/admin) rebuilds a head carrying another item's unlanded commits; `refresh` `{"reason":…, "base":SHA}` (coordinator, admin or an `intent:unblock` operator agent) merges the observed base tip into the branch under the carry rules.
- `claim` `{}`; `heartbeat`, `release` `{"epoch":1}` (`release` may carry `"cause"` or `"failure"`; an untouched claim keeps its epoch); `blocked` `{"epoch":1,"reason":…,"partialWork":…}` (a reason releases; null clears); `blocker-probe` (coordinator; a `pass` clears a routine [blocker](leases.md#blocked-work-unblocks-itself)); `workspace` `{"epoch":1,"host":…,"path":…,"branch":"graphyard/gy-1-1"}`.
- `submit`: `{"epoch":1,"pr":123}`; `409` if a non-`plannedFiles` file [regresses shipped code](../coordination.md#refuse-candidates-that-revert-shipped-code-outside-their-scope) or an applied retro check fails.
- `deployment`: `{"sha":…, "mergeSha":…, "source":"endpoint", "observedAt":…}`; coordinator/admin, delivered work, once.
- `triage` `{judgement}` (coordinator): [backlog](../master-agent.md#machine-filed-backlog).
- `POST /api/retro/synthesize` (coordinator/admin) drafts [retro artefacts](../operations-reference.md#retro-synthesis); `POST /api/retro/ID/approve|refuse` `{reason}` (`403`; `409` once judged).

No endpoint sets lifecycle state.

## Splitting an item

Before first dispatch the loop judges an item against `run.decomposition` bounds (defaults: 4 criteria, 2 root directories, 12 paths, ~1,500 lines); over them, a read-only Pi session (`run.research` account) proposes 2–10 children, so GitHub lands small PRs. Within bounds, `"split": false`, a keep-whole answer or a failed run dispatches the item unchanged (`"split": true` runs the session regardless). A split is one transaction: each parent criterion goes to exactly one child, each child's `plannedFiles` sits inside the parent's, `after` orders children, and children inherit the parent's release, dependencies, `exclusiveResources`, policy and documentation criterion. The parent is never dispatched; children may add criteria but not rewrite inherited ones, and the last child's delivery delivers the parent.

## Other commands and routes

`graphyard help` describes every command; also: `handoff GY-N`, `human-requests`, `rereview GY-N [EPOCH]`, `scenarios`, `scenario file.json`, `master guide|autonomy|decisions|withdraw|close|context|refuse|principals`, `db status|backup|verify|restore`, `grants history`, `delivery observations`, `operator-agent list|setup|configure|rotate|revoke`, `runner account-digest|adapters`.

Further routes: executor `/api/actions`, `/api/actions/claim`; worker pull `/api/assignments/claim`; fleet `/api/agent-registry`, `/api/agent-registry/apply|select|document|history|connect|connect/host-key|connect/hosts|connect/providers|connect/requests`; validation `/api/validation/analytics|capacity|definitions|artifacts|artifacts/migrate|replay|replays|reuse|collection-authority|collection-heartbeat|cancel|settle|retry`; delivery `/api/delivery/observations|select|sweep`; direct merges `/api/direct-merges`, `/api/direct-merges/on|off`; and `/api/events/stats`, `/api/human-requests`, `/api/intake`, `/api/interventions/patterns`, `/api/judgements`, `/api/operator-agents`, `/api/principals`, `/api/production-environment`, `/api/scenarios`.

Pattern routes: `GET /api/attribution/work/ID`, `/api/attribution/manifest/ID/N`, `/api/validation/attempt/ID`, `/api/validation/candidate/ID`, `/api/work/ID/context`, `/api/work/ID/decisions`; `POST /api/work/ID/close|closed-question|lead-ruling`, `/api/agent-registry/runtimes|models|accounts|roles[/NAME/remove|quota]`, `/api/agent-registry/sessions/ID/end`, `/api/agent-registry/connect/ID/claim|progress|result|cancel|answer`, `/api/operator-agents/NAME/configure|rotate|revoke`.
