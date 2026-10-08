<!-- page: Agent protocol | 1 | work mutations. -->
# Work commands

All but `/healthz` need `Authorization: Bearer TOKEN` ([roles](../glossary.md#the-roles-at-a-glance)); mutations `Idempotency-Key`, reused only for identical retries. Errors: `{"error":"reason"}`; `409`: refusal, not retried.

`POST /api/work` ([example](../../examples/work.json)): `title`, `criteria`; optionally `dependencies`, `exclusiveResources`, `plannedFiles`, `split` ([decomposition](#splitting-an-item) opt-out/in), `producerProofs` (producer-runnable `manual:` proofs); `parent`/`children` only split sets. Others: `POST /api/work/KEY/COMMAND`:

- `requirements`: document, `expectedPolicyRevision`, `reason`; `admin` (operator agents additively); omitted `split` kept; stale revisions refused before lease/quarantine checks. `rule: "successor"` (operator agents, additive) marks loop's re-plan onto split or renamed files; interventions skip it.
- `decomposition` (coordinator): `{event:"started"|"decided"|"failed",…}`; `decided` (`payload.children`) [splits](#splitting-an-item).
- `ready`, `unblock`: `{"reason":…}` (operator agents: `expectedRevision`; `master unblock` retries stale refusals ≤3). Two-party `release`/`unblock`/pinned `close` decisions survive loop bookkeeping; others settle `stale`. Head-bound `rework` (`input.binding` `SHA:GROUNDS`) is refused while another candidate stands, its approval settling `stale`.
- `resolve`: `{"trigger":…,"expectedRevision":…,"reason":…}`; human `admin`, or `admin` with `"attestation":{"kind":"blocked"|"stopped-worker","epoch":N}` explaining `lease-loss`.
- `rework`, `recover` (delivered quarantine): `admin`, `{"reason":…,"previousWorkerStopped":true}`.
- `repair` `{"reason":…}` (coordinator/admin) rebuilds head carrying another item's unlanded commits; `refresh` `{"reason":…,"base":SHA}` (coordinator/admin/`intent:unblock` operator agent) merges base tip into open candidate, keeping carried approval.
- `claim` `{}`; `heartbeat`, `release` `{"epoch":1}` (`release` takes `"cause"` or `"failure":{"message":…}` → `workspace.failed`; untouched claims keep epochs); `blocked` `{"epoch":1,"reason":…,"partialWork":…}` (reason releases; null clears); `blocker-probe` (coordinator; `pass` clears routine [blocker](leases.md#blocked-work-unblocks-itself)); `shadow-verdict` (coordinator; observation-only `shadow.verdict`); `workspace` `{"epoch":1,"host":…,"path":…,"branch":"graphyard/gy-1-1"}`, optional `preserved` (`workspace.preserved`).
- `submit`: `{"epoch":1,"pr":123}`, or under the `control-plane` [merger](../delivery-redesign.md#the-merger-setting) `{"epoch":1,"head":SHA}` (`complete GY-N EPOCH --head [SHA]`, default worktree HEAD): the control plane allocates one change number per head into `candidate.pr`/`submission.pr` and observes it locally, pushing nothing; the other form: `409`. `409` if non-`plannedFiles` file [regresses shipped code](../coordination.md#refuse-candidates-that-revert-shipped-code-outside-their-scope) or applied retro check fails.
- `deployment`: `{"sha":…,"mergeSha":…,"source":"endpoint","observedAt":…}`; coordinator/admin, delivered work, once.
- `triage` `{judgement}` (coordinator): [backlog](../master-agent.md#machine-filed-backlog); approver-refused closures return to triage with reason; same closure on unchanged item dropped unrecorded.
- `POST /api/retro/synthesize` (coordinator/admin) drafts [retro artefacts](../operations-reference.md#retro-synthesis) as caller; `POST /api/retro/ID/approve|refuse` `{reason}` (`403`; `409` once judged).

No endpoint sets lifecycle state.

## Splitting an item

Before first dispatch, items over `run.decomposition` bounds (4 criteria, 2 root directories, 12 paths, ~1,500 lines) get a read-only Pi session (`run.research`; `concurrency` 4, `timeoutMinutes` 10) proposing 2–10 children; `"split": false`, keep-whole answers, refused splits and failed runs dispatch unchanged; `"split": true` forces it. Each criterion goes to one child, `plannedFiles` inside the parent's; `after` orders children; they inherit release, dependencies, `exclusiveResources`, policy and documentation criterion. Unclaimed parents refuse requirements revisions; children only add criteria; the last delivery delivers the parent (`decomposition.parent-delivered`).

## Other commands and routes

Routes (`graphyard help` lists commands): executor `/api/actions[/claim]`; worker `/api/assignments/claim`; fleet `/api/agent-registry`, `/api/agent-registry/apply|select|document|history|connect|connect/host-key|connect/hosts|connect/providers|connect/requests`; validation `/api/validation/analytics|capacity|definitions|artifacts|artifacts/migrate|replay|replays|reuse|collection-authority|collection-heartbeat|cancel|settle|retry`; delivery `/api/delivery/observations|select|sweep`; `/api/direct-merges[/on|off]`; `/api/events/stats`, `/api/human-requests`, `/api/intake`, `/api/interventions/patterns`, `/api/judgements`, `/api/operator-agents`, `/api/principals`, `/api/production-environment`, `/api/scenarios`.

Pattern routes: `GET /api/attribution/work/ID`, `/api/attribution/manifest/ID/N`, `/api/validation/attempt/ID`, `/api/validation/candidate/ID`, `/api/work/ID/context`, `/api/work/ID/decisions`; `POST /api/work/ID/close|closed-question|lead-ruling`, `/api/agent-registry/runtimes|models|accounts|roles[/NAME/remove|quota]`, `/api/agent-registry/sessions/ID/end`, `/api/agent-registry/connect/ID/claim|progress|result|cancel|answer`, `/api/operator-agents/NAME/configure|rotate|revoke`.
