<!-- page: Operate Graphyard | 10 | criteria -->
# Coordination

## Write observable criteria

Criterion: `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. `unit:`/`integration:`: producer-runnable on exact head; `manual:`: two-party attestation unless in `producerProofs`; `e2e:`: [runner](validation.md). Any trusted pass proves it whatever it executed. `master create` plans; rewrite/removal/narrowing of requirements: two-party `master decide GY-N requirements`, lapsing evidence/review/authorization. Post-ship/production/host outcomes need `manual:post-deploy/NAME` or a per-clause observation; never merge-gating.

## Dispatch optimistically, smallest scope first

A dispatch plan (paths, `/`-ending prefixes) keeps parallel work apart and never locks: `sync` and the merge writer's trial integrate overlaps (`master status`: `overlap.concurrent`, `merge-tree` failures). Root-level directories (`highConflict`) need `--allow-broad-scope`; only `exclusiveResources` hold dispatch. Docs and `verification/AREA.md` maps whose `Paths:` cover planned files stay widen-time.

**3** single-cause dispatch failures, fleet-idle excluded: `dispatchblock` until `graphyard unblock GY-N REASON`.

## Review gate: verdicts, not threads

Exact-head approval lands; remote threads and reviews are never read or resolved. Past cap (default 3) only `BLOCKING:` holds; repeats escalate (`master decide rework`). Sensitive ([`pre-merge`](delivery.md#managed-repositories): any) needs exact-head approval; normal merges, post-merge review files `BLOCKING:` bugs. Control-plane mode switches off plan refusals, sync restore, the scope hook, producer sessions, budget-test blockers, normal-risk rework approvers.

`Nit: PATH:LINE — FINDING` ends `(mechanical: …)` or `(substantive: …)`; behaviour/criterion/scope signs: substantive. Mechanical findings hold approval until the round window or the loop's clear; the loop requests bot `rework`, one commit, only those files. `Rejected bot commit: SHA — reason` records `misclassified-finding` ([intervention](operations.md#retro-synthesis)).

## Scope is a plan, not a lock

The plan keeps parallel work apart at dispatch and hints at the change; nothing refuses a file outside it. `graphyard sync GY-N` merges `origin/BASE`, regenerates the generated files and reports only merge conflicts;

Workers build, run the request-named fast gates (the managed block's set, plus scripts/check-docs.mjs) and `graphyard verify GY-N` (own proofs; CI: all), submit on pass, naming out-of-scope sandbox failures. `leftToCi` (exit 0, `passing`): all passed, abnormal end; failed/skipped/unexecuted block.

### Generated files and speed

`GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` paths are `generated`: only deletion refuses; `sync` regenerates.

[Speed](master-agent-reference.md#pipeline-speed), CI proofs. `graphyard diagnose GY-N` names holds; docs-only conflicts get [docs-sync](development.md#documentation-that-rarely-conflicts). Permanent installation-level stall reasons raise setup attention: `Deployment endpoint answered 4xx` → fix `deploymentUrl`; a credential-401 refusal → its remedy; a refused reviewer launch → repair the reviewer identity (GY-2008).
