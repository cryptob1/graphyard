<!-- page: Operate Graphyard | 10 | write criteria and advance work -->
# Coordination

## Write observable criteria

Use `{"id":"AC-1","text":"OUTCOME","proofs":["integration:NAME"]}`. Unit/integration proofs name exact-head runnable checks. Every item, including chores, also needs an `e2e:NAME` proof bound to a new or existing [repository case](validation.md#every-item-carries-an-e2e-proof); no description opts out. Control-plane acceptance requires trial cases executed with none failing. Sensitive changes also need required manual attestations; producer evidence cannot replace trial counts.

Post-ship outcomes use `manual:post-deploy/NAME` or per-clause observations, not pre-merge requirements. `master requirements` invalidates old evidence/review/authorization. Never weaken requirements to pass implementation.

Single-fixture proofs warn: cover three cases or explain why one suffices. Reviewers inspect code and coverage for other inputs; `e2e/cases/` paths bind proofs rather than sample inputs. They assess every criterion and post APPROVE or REQUEST_CHANGES without running builds, tests or servers. Exact-head execution belongs to the automated merge trial, with no human step.

## Dispatch optimistically

Only exclusiveResources lock dispatch. Sync and merge trials integrate path overlaps; status reports conflicts. Sessions receive matching verification maps. Failed dispatch retries next cycle.

## Review gate: verdicts, not threads

Only reviewer-session verdicts supply review approval. The stored `reviewProvider` name remains `github` (also the default); create refuses `codex`, `agent`, and their reviewer profiles.

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

## Decision reads

Single-item lifecycle decisions use `store/decision-read.ts` inside the existing fleet/item transaction. They load the focus, transitive prerequisites, post-deployment parent, bootstrap declarations and deliveries carrying those deferred proofs. Resource conflicts read only `work_index.peers` (lease and resource names); submission also selects any existing owner of its PR. The index trigger updates selectors atomically with the document, including raw writes and restores. No cache warm-up is needed. The peer-column migration records a new schema generation and adds the column only when absent, so rerunning unchanged DDL does not wait on live coordination writes. Creation and requirement revision still inspect the dependency graph; workspace registration still checks all reservations.

The reader audit for GY-3035 distinguishes decision inputs from board presentation:

| Reader | Fields consumed and retained | Scope |
| --- | --- | --- |
| `fleet` | Open documents; settled coordination summaries. Status, board, dispatch offers and reports read stage, gates, next action, lease, criteria, candidate, evidence, sessions and action rows. | Board, outside decision locks |
| `list` | Whole documents, including prose and histories, for explicit full readers. | Board |
| `workSnapshot` | Whole documents plus job availability, locks, errors and holds; full snapshots and wait reporting need histories. | Board |
| `coordinationSnapshot` | Identity, requirements, stage, gates, next action, leases, candidates, relevant evidence, bounded sessions/action histories and job state; master dispatch and executors consume these. | Board, SQL-trimmed; settled rows from index |
| `boundedSnapshot` | Open documents and settled display summaries, plus jobs. | Board display |
| `snapshotPage` | The bounded/full fields above for selected item numbers; jobs and cursor metadata. | Requested page only |

Claim checks readiness/blocker, dependency stage and resource leases. Submit checks epoch, workspace, PR ownership and candidate observation. Evaluation, review, evidence, waits and merge recording read the focus's requirements, evidence, candidate, sessions and action state; their cross-item inputs are dependency identities/stages, inherited bootstrap contracts/proofs and follow-up delivery bindings. Close additionally reads its named duplicate/superseding item. Requirement edits validate dependency existence/cycles; workspace registration compares branches and host/path reservations. Reconciliation and fleet scheduling still inspect the board to discover work and propagate changed inputs.

The audit leaves no unused derived field to remove: gates drive next-action/refusal decisions, stage drives dependency readiness and terminal behavior, and next action drives indexed scheduling and snapshots. Display keeps the existing evaluated result. `snapshot-delta` still serves event/history readers, `onlyActionsMovedSince` still distinguishes observation races from queue bookkeeping, and reconciliation's face moves still determine affected items. These remain until those consumers change. `decision-reads-peers.test.ts` counts documents (including SQL projections) for a cold claim, submit and evaluation on 2,000 items; `server-scale` and `healthz-bounded` retain the board and probe bounds.
