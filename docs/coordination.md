<!-- page: Operate Graphyard | 8 | requirements, overlap. -->
# Coordinating independent agents

For anyone changing what an item requires or owns: what may be revised, and what holds a dispatch.

## Observable requirements

A criterion states an outcome and names its required proofs, in the [revision format](#revise-requirements-explicitly) below.

- **Assertions:** the repository's tests define them; Graphyard checks evidence identity, version, result and counts.
- **E2E:** register an [E2E scenario](test-cases.md) before naming it, authorizing its reporter separately.
- **`unit:` and `integration:` proofs:** producer-runnable; a producer session per proof group is requested once the candidate passes the build gate.
- **`manual:` proofs:** need a two-party `attest` decision unless the item lists them in `producerProofs`, which only says who may run them.
- **`e2e:` proofs:** run through the [validation runner](validation.md).
- **States:** **unmeasured**, **incomplete**, **failed** or **passed**.
- **Cannot pass:** untrusted assertions and evidence for another head, base, policy, scenario or environment; a later matching failure supersedes an earlier pass.

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

- **Declared human `admin` session:** may use **Revise requirements** or `graphyard requirements GY-N revision.json`.
- **Whole-document replace:** omitted criteria are removed; an omitted `producerProofs` leaves every manual proof to an `attest` decision.
- **Criterion IDs:** kept when clarifying the same obligation; removed IDs are retired, never recycled.
- **Dependencies:** must exist, without a cycle.
- **Concurrent edits:** compare `expectedPolicyRevision`.
- **Append-only history:** every revision records the actor, reason, complete requirements and new policy revision.
- **First:** stop the worker and release its lease.
- **Rewrite:** raises the `requirement-weakening` escalation.
- **Invalidated:** review requests, observations and merge authorization; previous acceptance evidence stays in history, inapplicable; submitted work needs a new attempt and resubmission.
- **Merging:** suspend until the refusing check shows; delivered work needs a follow-up item.
- **Withdraw accepted runs without changing requirements:** [revoke that evidence](operations-reference.md#accepted-evidence-turns-out-to-be-wrong).
- **E2E pins:** existing ones are kept, newly added proofs pin the latest; a revision always refuses [reuse](evidence-reuse.md) of an executed pass.

## Overlap and scheduling

- **`plannedFiles`:** exact repository-relative paths or directory prefixes ending in `/`, `/*` or `/**`, all including descendants; globs, historical renames and semantic dependencies are not inferred.
- **Compared:** planned paths and observed pull-request files, against other unfinished ready, assigned or submitted work. Overlap never blocks a claim.

### Schedule by overlap, smallest scope first

`plannedFiles` are a soft exclusive resource against every claimed or submitted, unmerged item.

- **`master dispatch` and the durable loop:** refuse such a dispatch, naming the item ahead and the overlapping paths.
- **Hold nothing:** two overlapping *ready* items until one is dispatched, delivered work, an expired lease.
- **Advisory hold:** `master dispatch GY-N PROFILE --allow-overlap` dispatches anyway, recording the overlap; the loop never uses it. Exclusive resources, dependencies, blockers and quarantines still refuse.
- **Order:** ready items dispatch smallest planned scope first within a priority: fewest root-level directory scopes, then fewest directory scopes, then fewest files, then the older item; a root-level scope is flagged `highConflict`.
- **`master status`:** reports which open candidates git cannot merge each candidate with (`git merge-tree` over the fetched PR heads), the conflicting files per pair, and a fewest-conflicts-first sequence.
- **Path outside scope:** a [scope request](#scope-requests-the-loop-decides), keeping the lease; never a free-text blocker.

### Scope requests the loop decides

- **Asked:** a worker needing a file outside `plannedFiles` runs `scope-request GY-N EPOCH PATH... -- REASON`, keeping its lease
- **Decided:** the cycle it appears, by the control plane at the loop's request (`POST /api/work/:id/autoscope`, the coordinator's only scope call), recomputed from the item
- **Approved, applied to the live item as an additive widening:** documentation the repository requires updating when behaviour changes (`docs/`, `AGENTS.md`, `README.md`, file by file), and source files the item's criteria name
- **Refused and escalated, the item blocked on `Scope request refused: …`:** any other path (`master scope GY-N REASON` applies it), and a request dropping planned paths or rewriting criteria or proofs (`master requirements GY-N FILE REASON`)

## Reserve explicitly shared resources

- **`exclusiveResources`:** resources that cannot be assigned concurrently, such as `staging:sms-test-account`.
- **Names:** case-sensitive lowercase identifiers of letters, digits, `.`, `_`, `:`, `/` and `-`, one per real resource installation-wide.
- **Claiming:** atomically reserves every declared name; a conflicting active assignment refuses the whole claim.
- **`next` and dispatch:** exclude work with busy resources.
- **Lifetime:** reservations follow the lease; an assignment under a containment quarantine keeps them until verified settlement or a confirmed stopped-worker recovery.
- **Delivered work:** that recovery removes only the quarantine and its fence, preserving Done, gates, candidate, evidence, observation, merge authorization and delivery.
- **Reservations, not locks:** a disconnected process may still reach an external system with its own credentials.

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` also bounds what a candidate may change.

- **`complete`:** refuses with the exact file list and the delivered items whose scope shipped each path, recording nothing.
- **Reconciliation:** re-derives the same refusal for the current head into the `build` gate, the required check, `diagnose` and the work detail.
- **`graphyard sync GY-N`** (the worker's half): `git fetch origin && git merge origin/BASE`, regenerating the generated files, committing, then classifying the local diff with the same rules and exiting non-zero before any push.
- **Requirements set scope, not the worker:** `workspace`, `submit` and `evidence` never accept `plannedFiles`; only an audited [`requirements` revision](#revise-requirements-explicitly) or an approved scope request changes it.

### The landing re-check

A candidate's bound base is held on purpose while its head is unchanged, so a head clean at submit can later delete what another item shipped. Every observation of an open candidate — each reconciliation, and the fresh one the guarded merge takes immediately before the provider call — therefore runs the same judgement against the commit it would **actually land on**, recorded as `landing`.


### Generated files never conflict

- **Generated:** the docs indexes `docs/README.md` and `docs/protocol.md` and the managed `AGENTS.md` blocks.
- **`npm run docs:check -- --write`:** renders the indexes in full from each page's `<!-- page: Section | order | summary -->` line.
- **`docs:check`:** fails CI when one is stale.
- **`--manifest`:** prints their paths, telling `sync` what to regenerate.
- **`graphyard init` and `master init`:** render the `AGENTS.md` blocks from templates; a test fails while the committed file differs.
- **Regression guard:** classifies a generated file as `generated`, not an out-of-scope rewrite, learning the set from `GRAPHYARD_GENERATED_FILES`, here `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md`.
- **Unset:** nothing is exempt; deleting a generated file is still refused.

## Ship in under thirty minutes

The [routine-item target](master-agent.md#pipeline-speed) rests on five mechanisms, none weakening a review, evidence, identity, lease or protection rule: [the regression guard and `sync`](#refuse-candidates-that-revert-shipped-code-outside-their-scope), [automatic dispatch at submit](executors.md#automatic-dispatch-at-submit), [proofs in CI](github.md#proofs-in-ci), [conflict avoidance](#schedule-by-overlap-smallest-scope-first) and [measurement](protocol/pipeline-speed.md) of every item's timeline.

## Explain stalls and drill the recovery

- **`base-behind`:** a submitted head not containing the base tip; waits on Graphyard's [base refresh](protocol/merge-queue-binding.md#base-refresh) not a person; never an attention item.
- **`base-conflict`, `base-refresh-carried` and `base-refresh-required`:** what that refresh could not absorb and what it kept.
- **`queue-binding-carried`, `queue-binding-required` and `queue-base-carried`:** reported by a queued candidate, per binding.
