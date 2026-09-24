<!-- page: Operate Graphyard | 8 | dependencies, requirement revisions, overlap, and shared resources. -->
# Coordinating independent agents

Graphyard owns assignment and evidence admissibility; Herdr owns session processes; Git owns source history. Terms: [glossary](glossary.md).

## Start with an observable requirement

A criterion states an outcome and names its required proofs:

```json
{ "id": "AC-1", "text": "Retrying a confirmed booking produces exactly one SMS request", "proofs": ["integration:sms-idempotency", "e2e:confirmed-booking-sms"] }
```

The repository's tests define the assertions; Graphyard checks evidence identity, version, result and counts. A proof name alone does not establish a trusted producer ([protocol](protocol/evidence.md)).

Every `unit:` and `integration:` proof is producer-runnable: when the build gate passes, the control plane requests a producer session per proof group on the exact head ([automatic dispatch](master-agent.md#automatic-dispatch-at-submit)). A `manual:` proof is attested through a two-party `attest` decision unless the item lists it in `producerProofs`, which marks it producer-runnable in the `manual` group. `e2e:` proofs run through the validation runner.

Evidence for another head, base, policy, scenario or environment never passes; a later matching failure supersedes a pass.

## Revise requirements explicitly

Adding requirements needs only the master's operator-agent identity; rewriting, removing or narrowing is a two-party decision:

```sh
graphyard master requirements GY-N revision.json "REASON"            # additions only
graphyard master decide GY-N requirements @revision.json "REASON"   # rewrites and removals
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

The revision replaces the whole document (omitted criteria are removed, their IDs retired). Stop the worker first. Previous evidence, review and merge authorization lapse; submitted work needs a new attempt, delivered work a follow-up item. To withdraw specific runs instead, [revoke the evidence](protocol/evidence.md#revocation).

## Detect overlap

`plannedFiles` holds exact repository-relative paths or directory prefixes ending in `/`, `/*` or `/**` (all include descendants). Planned paths and observed PR files are compared against other unfinished work, with overlaps shown on cards. Overlap never blocks a claim.

### Schedule by overlap, smallest scope first

Overlap blocks *dispatch*, advisorily and for a bounded time, against items in flight (claimed, quarantined, or submitted with a standing candidate).

- Before a candidate exists, `plannedFiles` are compared; afterwards, only the files the candidate actually changed.
- Name files, not directories. A root-level directory (`src/`, `docs/`, `tests/`, `/`) is flagged `highConflict`, and `master create`, `master requirements` and `master scope` refuse it unless `--allow-broad-scope` records the exception. Broad scopes serialise the fleet.
- `master dispatch` and the loop hold an overlapping item, naming the item ahead, the paths and the hold age. After two hours (`dispatchHoldBoundMs`) the hold lapses into an attention item. `master dispatch GY-N PROFILE --allow-overlap` overrides; it lifts nothing else.
- Ready items dispatch smallest planned scope first within a priority.
- `master status` lists open candidates git cannot merge together (`git merge-tree`) and a fewest-conflicts-first sequence ([conflict avoidance](master-agent-reference.md#conflict-avoidance)).

## Reserve explicitly shared resources

`exclusiveResources` names (such as `staging:sms-test-account`) are reserved atomically at claim; a conflict refuses the claim. Reservations follow the lease, but a containment quarantine keeps them until it is [settled](protocol/containment-settlement.md) or an approved `rework` or `recover` decision clears it. They are coordination reservations, not access control.

## Refuse candidates that revert shipped code outside their scope

`plannedFiles` also bounds what a candidate may change. At `complete`, on every new head, and at [landing](#the-landing-re-check):

- Files inside scope pass, as do new files nobody shipped.
- Every other file must match the bound base byte-for-byte. A deletion, revert, rewrite, rename away or differing binary is refused, and so is a file that could not be compared.
- `complete` refuses with the file list and the delivered items that shipped each path; after acceptance the same refusal shows in the `build` gate, the `Graphyard / merge` check and `diagnose`.

A worker cannot widen `plannedFiles`; only an audited [requirements revision](#revise-requirements-explicitly) or `master scope` can. A master returning a refused candidate requests a two-party `rework` decision quoting the file list.

### The landing re-check

Each observation, including the guarded merge's final one, re-judges against the commit the candidate would land on, recorded as `landing`: `landing.files` catches deletions the PR diff cannot show, `landing.carried` a head carrying another candidate's commits without their content. A landing regression refuses the `build` gate and ejects a queued entry.

### Keep current with `graphyard sync`

```sh
graphyard sync GY-N
```

Merges `origin/BASE` (never a rebase), regenerates [generated files](#generated-files-never-conflict), commits, and runs the same classification locally before any push. On a conflict, resolve, stage and rerun. Restore an out-of-scope file with `git checkout BASE_TIP -- PATH`.

### Generated files never conflict

- `docs/README.md` and `docs/protocol.md` are generated by `npm run docs:check -- --write` ([development](development.md)); `sync` regenerates them after every merge.
- The managed `AGENTS.md` blocks are rendered by `graphyard init` and `master init`; `sync` re-renders them on conflict.
- The regression guard classifies files in `GRAPHYARD_GENERATED_FILES` (here `GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md`) as `generated`, not out-of-scope rewrites; deleting one is still refused.

## Ship in under thirty minutes

Target for a routine item: submit→merge p50 at most 30 minutes and p90 at most 60, over at least ten deliveries, with at most one rework round ([pipeline speed](master-agent-reference.md#pipeline-speed)). None of the mechanisms weakens a gate: the regression guard and `sync`, [automatic dispatch at submit](master-agent.md#automatic-dispatch-at-submit), [proofs in CI](github.md#proofs-in-ci) on the queue tip, and conflict avoidance.

## Explain stalls

```sh
graphyard diagnose GY-N
```

Explains dependencies, blockers, ownership, resources, stale PRs, integration failures and the first refusing gate. `base-behind` means Graphyard will [refresh the base](github.md#base-refresh-for-in-flight-candidates) itself; `base-conflict` needs rework. Diagnosis never sets lifecycle state.

## Two-machine operational drill

Use two real hosts and two worker principals; the [`integration:herdr-recovery` contract](herdr.md#automated-recovery-contract) is not evidence of this drill.

1. Connect both hosts (`graphyard init --herdr --token-stdin`) with distinct host and principal IDs.
2. Claim one item from both at once: one winner, one refusal.
3. Cut the winner's connection under `watch`; the supervisor kills the child.
4. After expiry, claim from the other host at a higher epoch; the first host's old-epoch heartbeat, registration and submission must refuse.
5. Submit from the new owner; a push after review must void the old approval.
6. Exercise duplicate and delayed webhooks and an integration outage, finish through normal gates, and record hosts, epochs, logs, CI and PR URLs.
