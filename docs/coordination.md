<!-- page: Operate Graphyard | 10 | write criteria and advance work -->
# Coordination

## Write observable criteria

Use `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. Unit/integration proofs name exact-head runnable checks. Every item, including chores, also needs an `e2e:NAME` proof bound to a new or existing [repository case](validation.md#every-item-carries-an-e2e-proof); no description opts out. Control-plane acceptance requires trial cases executed with none failing. Sensitive changes also need required manual attestations; producer evidence cannot replace trial counts.

Post-ship outcomes use `manual:post-deploy/NAME` or per-clause observations, not pre-merge requirements. `master requirements` invalidates old evidence/review/authorization. Never weaken requirements to pass implementation.

Single-fixture proofs warn: cover three cases or explain why one suffices. Reviewers inspect code and coverage for other inputs; `e2e/cases/` paths bind proofs rather than sample inputs. They assess every criterion and post APPROVE or REQUEST_CHANGES without running builds, tests or servers. Exact-head execution belongs to the automated merge trial, with no human step.

## Dispatch optimistically

Only exclusiveResources lock dispatch. Sync and merge trials integrate path overlaps; status reports conflicts. Sessions receive matching verification maps. Failed dispatch retries next cycle.

## Review gate: verdicts, not threads

Graphyard reads exact-head verdicts, not remote review threads. Pre-merge review judges implementation and bound E2E coverage: missing later trusted results do not block approval; missing or inadequate tests can. The writer must pass every required exact-head E2E proof before updating main; workers never submit trusted evidence. Sensitive changes need approval before merge. Normal changes receive post-merge review; blocking findings become follow-up bugs. Pre-merge `BLOCKING:` findings cause rework once per submission, without a round cap.

Review launch and retry briefs retain the launch snapshot’s criterion IDs, proof names, E2E case IDs/paths and available scenario revision, environment and hash. Reviewers read cases with `git show HEAD:PATH` and procedures with `graphyard guide review`, without worker/coordinator credentials. For a guessed path or command failure, use `rg --files` or CLI `--help` and correct the read, including on retries. Only unavailable inputs after authorized equivalent reads, or real permission, identity, binding or runtime failures, warrant blockers. Briefs include discovery and recovery; `guide review` classifies findings. Reviewers stay read-only and post one verdict.

Reviewer and spec-check launch bearers authenticate from committed launch records, including delivered items, so unexpired unused tokens survive server restarts. Recovery grants only the launch's reader identity; verdicts retain their token, head, requirements revision and independence checks. Recording, refusing, replacing or clearing a launch revokes its token; expiry needs no process-local cleanup. Session reconciliation can release an unusable session without supplying an approval.

Use `Nit: PATH:LINE — FINDING`, ending with `(mechanical: …)` or `(substantive: …)`; findings about behavior, criteria or scope are substantive. Nits stay advisory: they never hold approval or trigger a bot round. Graphyard keeps them in project memory for later workers. Put required fixes on `BLOCKING:` lines; see `guide review`. Control-plane mode switches off plan refusals, sync restore, the scope hook, producer sessions and budget-test blockers.

## Scope is a plan, not a lock

`plannedFiles` is accepted but ignored; no file-widening permission is needed. `graphyard sync GY-N` merges shared `origin/BASE` and regenerates generated files; only merge conflicts hold it.

Workers run `graphyard verify GY-N` for their proofs; CI owns the full suite. A failed, skipped or unexecuted own proof blocks submission. `leftToCi` with exit 0 and `passing` means the selected tests passed before an abnormal runner end. Name unrelated sandbox failures in the commit message.

### Generated files

`GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md` marks generated paths. Deletion refuses; sync regenerates them. Edit source metadata or the generator, not the index.

`graphyard diagnose GY-N` names holds. Installation faults raise setup attention: fix a 4xx deployment endpoint URL, a credential's 401, or a refused reviewer launch at its source.
