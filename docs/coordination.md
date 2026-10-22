<!-- page: Operate Graphyard | 10 | criteria -->
# Coordination

## Write observable criteria

Criterion: `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. `unit:`/`integration:`: producer-runnable on exact head; `manual:`: master attestation unless in `producerProofs`; `e2e:`: [runner](validation.md). Any trusted pass proves it whatever it executed. `master create` plans; `master requirements` rewrites, lapsing evidence/review/authorization. Post-ship/production/host outcomes need `manual:post-deploy/NAME` or a per-clause observation; never merge-gating.

## Dispatch optimistically

Dispatch never locks paths: `sync` and the merge writer's trial integrate overlaps (`master status`: `overlap.concurrent` on observed files, `merge-tree` failures); only `exclusiveResources` hold dispatch. A session gets the `verification/AREA.md` maps whose `Paths:` cover a path its item's criteria or description name.

A failed dispatch is retried next cycle, never blocked.

## Review gate: verdicts, not threads

Exact-head approval lands; remote threads and reviews are never read or resolved. A `BLOCKING:` finding reworks the item once per submission, uncapped. Sensitive ([`pre-merge`](delivery.md#managed-repositories): any) needs exact-head approval; normal merges, post-merge review files `BLOCKING:` bugs. Control-plane mode switches off plan refusals, sync restore, the scope hook, producer sessions, budget-test blockers.

`Nit: PATH:LINE — FINDING` ends `(mechanical: …)` or `(substantive: …)`; behaviour/criterion/scope signs: substantive. Mechanical findings hold approval until the round window or the loop's clear; the loop requests bot `rework`, one commit, only those files. `Rejected bot commit: SHA — reason` rejects it.

## Scope is a plan, not a lock

`plannedFiles` is accepted and ignored; nothing requests, widens, splits or refuses a file. `graphyard sync GY-N` merges `origin/BASE`, regenerates generated files, reports only merge conflicts;

Workers build, run `graphyard verify GY-N` (own proofs; CI: all), submit on pass, naming out-of-scope sandbox failures. `leftToCi` (exit 0, `passing`): all passed, abnormal end; failed/skipped/unexecuted block.

### Generated files and speed

`GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` paths are `generated`: only deletion refuses; `sync` regenerates.

[Speed](master-agent-reference.md#pipeline-speed), CI proofs. `graphyard diagnose GY-N` names holds. Permanent installation-level stall reasons raise setup attention: `Deployment endpoint answered 4xx` → fix `deploymentUrl`; a credential-401 refusal → its remedy; a refused reviewer launch → repair the reviewer identity (GY-2008).
