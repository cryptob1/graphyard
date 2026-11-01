<!-- page: Operate Graphyard | 10 | write criteria and advance work -->
# Coordination

## Write observable criteria

Use `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. Unit/integration proofs name exact-head runnable checks; E2E proofs bind [repository cases](validation.md). Control-plane acceptance requires trial cases executed with none failing. Sensitive changes also need required manual attestations; producer evidence cannot replace trial counts.

Post-ship outcomes use `manual:post-deploy/NAME` or per-clause observations, not impossible pre-merge requirements. `master requirements` invalidates old evidence/review/authorization. Never weaken requirements to pass implementation. Single-fixture proofs warn: cover three cases or explain why one suffices; reviewers try another case.

## Dispatch optimistically

Only exclusiveResources lock dispatch. Sync and merge trials integrate path overlaps; status reports conflicts. Sessions receive matching verification maps. Failed dispatch retries next cycle.

## Review gate: verdicts, not threads

Graphyard reads exact-head verdicts, not remote review threads. Sensitive changes need approval before merge. Normal changes receive post-merge review; blocking findings become follow-up bugs. Pre-merge `BLOCKING:` findings cause rework once per submission, without a round cap.

Use `Nit: PATH:LINE — FINDING` for advisory feedback. Graphyard keeps nits in project memory for later workers; no bot fixes them in control-plane mode. Put required fixes on `BLOCKING:` lines. Use `guide review` for the procedure. Control-plane mode switches off plan refusals, sync restore, the scope hook, producer sessions and budget-test blockers.

## Scope is a plan, not a lock

`plannedFiles` is accepted but ignored; no file-widening permission is needed. `graphyard sync GY-N` merges shared `origin/BASE` and regenerates generated files; only merge conflicts hold it.

Workers run `graphyard verify GY-N` for their proofs; CI owns the full suite. A failed, skipped or unexecuted own proof blocks submission. `leftToCi` with exit 0 and `passing` means the selected tests passed before an abnormal runner end. Name unrelated sandbox failures in the commit message.

### Generated files

`GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` marks generated paths. Deletion refuses; sync regenerates them. Edit source metadata or the generator, not the index.

`graphyard diagnose GY-N` names holds. Installation faults raise setup attention: fix a 4xx deployment endpoint URL, a credential's 401, or a refused reviewer launch at its source.
