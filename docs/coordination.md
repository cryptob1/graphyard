<!-- page: Operate Graphyard | 8 | requirements, overlap, scope. -->
# Coordinating independent agents

For anyone changing what an item requires or owns: what may be revised, and what holds a dispatch.

## Observable requirements

A criterion states an outcome and names required proofs: `{ "id": "AC-1", "text": "Retries produce one SMS request", "proofs": ["integration:sms-idempotency", "e2e:confirmed-booking-sms"] }`. The repository's tests define the assertions; Graphyard checks evidence identity, version, result and counts. Register an [E2E scenario](test-cases.md) before naming it, and authorize its reporter separately.

- Every `unit:` and `integration:` proof is producer-runnable, and a producer session per proof group is requested once the candidate passes the build gate; a `manual:` proof needs a two-party `attest` decision unless the item lists it in `producerProofs`, which only says who may run it, and `e2e:` proofs run through the [validation runner](validation.md).
- Required proofs show as **unmeasured**, **incomplete**, **failed** or **passed**; untrusted assertions and evidence for another head, base, policy, scenario or environment cannot pass, and a later matching failure supersedes an earlier pass.

## Revise requirements explicitly

Additions need only the master's operator-agent identity; a rewrite, removal or narrowing is a two-party decision the approver applies.

```sh
graphyard master requirements GY-N revision.json "REASON"          # additions only
graphyard master decide GY-N requirements @revision.json "REASON"  # rewrites and removals
graphyard master approver GY-N DECISION                            # the independent approver
```

```json
{
  "expectedPolicyRevision": 1,
  "reason": "Retries must preserve exactly-once behavior",
  "criteria": [{"id":"AC-1","text":"Retries produce one SMS request","proofs":["integration:sms-idempotency"]}],
  "dependencies": [],
  "plannedFiles": ["src/booking/", "src/sms/send.ts"],
  "exclusiveResources": ["staging:sms-test-account"],
  "producerProofs": []
}
```

- A declared human `admin` session may still use **Revise requirements** or `graphyard requirements GY-N revision.json`.
- The command replaces the whole document: omitted criteria are removed, and an omitted `producerProofs` leaves every manual proof to an `attest` decision. Keep a criterion ID when clarifying the same obligation; removed IDs are retired, never recycled. Dependencies must exist and cannot form a cycle, concurrent edits compare `expectedPolicyRevision`, and every revision records the actor, reason, complete requirements and new policy revision in append-only history.
- Stop the worker and release its lease first. A rewrite raises the `requirement-weakening` escalation; workers cannot weaken their own gates.
- Previous acceptance evidence stays in history but becomes inapplicable; review requests, observations and merge authorization are invalidated, and submitted work needs a new attempt and resubmission. Suspend merging until the refusing check is visible; delivered work needs a follow-up item.
- To withdraw accepted runs without changing requirements, [revoke that evidence](operations-reference.md#accepted-evidence-turns-out-to-be-wrong) instead. Existing E2E pins are kept, newly added proofs pin the latest, and a revision always refuses [reuse](evidence-reuse.md) of an executed pass.

## Overlap and scheduling

`plannedFiles` holds exact repository-relative paths or directory prefixes ending in `/`, `/*` or `/**`, all including descendants; globs, historical renames and semantic dependencies are not inferred. Planned paths and observed pull-request files are compared against other unfinished ready, assigned or submitted work. Overlap never blocks a claim: two compatible edits may legitimately touch one file.

### Schedule by overlap, smallest scope first

An item's `plannedFiles` are a soft exclusive resource against every item claimed or submitted but not merged, since whichever of two overlapping candidates lands second re-integrates the first.

- `master dispatch` and the durable loop refuse such a dispatch, naming the item ahead and the overlapping paths; two overlapping *ready* items hold nothing until one is dispatched, and delivered work and an expired lease hold nothing.
- The hold is advisory: `master dispatch GY-N PROFILE --allow-overlap` dispatches anyway and records the overlap, though the loop never uses it. Exclusive resources, dependencies, blockers and quarantines refuse as before.
- Ready items dispatch smallest planned scope first within a priority: fewest root-level directory scopes, then fewest directory scopes, then fewest files, then the older item; a root-level scope is flagged `highConflict`.
- `master status` also reports which open candidates git cannot merge each candidate with (`git merge-tree` over the fetched PR heads), the conflicting files per pair, and a fewest-conflicts-first sequence.
- A worker needing a path outside its scope runs `graphyard scope-request GY-N EPOCH PATH... -- REASON` (`-` withdraws it) and keeps its lease; the master approves with `graphyard master scope GY-N`. A free-text blocker is never needed for scope.

## Reserve explicitly shared resources

`exclusiveResources` names resources that cannot be assigned concurrently, such as `staging:sms-test-account`; names are case-sensitive lowercase identifiers of letters, digits, `.`, `_`, `:`, `/` and `-`, one per real resource installation-wide. Claiming atomically reserves every declared name, a conflicting active assignment refuses the whole claim, and `next` and dispatch exclude work with busy resources. Reservations follow the lease, except that an assignment under a containment quarantine keeps them until verified settlement or a confirmed stopped-worker recovery clears it; on delivered work that recovery removes only the quarantine and its fence, preserving Done, gates, candidate, evidence, observation, merge authorization and delivery. These are coordination reservations, not locks: a disconnected process may still reach an external system with its own credentials.

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` is also the boundary of what a candidate may change, because a worker that re-resolves a file it does not own silently deletes code that already merged.

- Every changed file is classified against `plannedFiles`; changes inside scope pass, and so do new files nobody has shipped.
- Every other file is compared by blob identity with the commit the candidate is bound to: a byte-for-byte match passes, while a deletion, revert, rewrite, rename away from a shipped path, differing binary or uncomparable file is refused.
- `complete` refuses with the exact file list and the delivered items whose scope shipped each path, recording nothing; reconciliation re-derives the same refusal for the current head into the `build` gate, the required check, `diagnose` and the work detail.
- `graphyard sync GY-N` is the worker's half: `git fetch origin && git merge origin/BASE`, regenerating the generated files, committing, then classifying the local diff with the same rules and exiting non-zero before any push. A conflicting merge stops with the remaining conflicted paths, each naming the shipped items that landed it; resolve, stage and rerun `sync`, restoring a file with `git checkout BASE_TIP -- PATH`.
- Scope is set by requirements, not by the worker: `workspace`, `submit` and `evidence` never accept `plannedFiles`, and only an audited [`requirements` revision](#revise-requirements-explicitly) or an approved scope request changes it.

### Generated files never conflict

The docs indexes `docs/README.md` and `docs/protocol.md` and the managed `AGENTS.md` blocks are generated, so nobody merges them by hand. `npm run docs:check -- --write` renders the indexes in full from each page's `<!-- page: Section | order | summary -->` line, `docs:check` fails in CI when one is stale, and `--manifest` prints their paths, which is how `sync` learns what to regenerate; `graphyard init` and `master init` render the `AGENTS.md` blocks, and a test fails while the committed file differs from the templates. The regression guard classifies a generated file as `generated` rather than an out-of-scope rewrite, learning the set from `GRAPHYARD_GENERATED_FILES` — here `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md`. Unset, nothing is exempt, and deleting a generated file is still a refused deletion.

## Explain stalls and drill the recovery

`graphyard diagnose GY-N` and the work-detail Coordination section explain dependencies, blockers, missing ownership or workspace, busy resources, unobserved or stale pull requests, integration failures, overdue unowned jobs, violations and the first refusing gate, including an out-of-scope regression with its file list. A submitted head not containing the base tip is `base-behind`, which waits on Graphyard's own [base refresh](protocol/merge-queue-binding.md#base-refresh) rather than on a person and is never an attention item; `base-conflict`, `base-refresh-carried` and `base-refresh-required` report what that refresh could not absorb and what it kept, and a queued candidate reports `queue-binding-carried`, `queue-binding-required` and `queue-base-carried` per binding. It is evidence, not a lifecycle-state setter.

How long the hops between `complete` and the merge may take is the [pipeline-speed target](master-agent.md#pipeline-speed); each item's own timeline is [`pipeline`](protocol/pipeline-speed.md).
