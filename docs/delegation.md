<!-- page: Operate Graphyard | 6 | slice leads, rulings, escalations. -->
# Slice-lead delegation

For an installation past one coordinator: what a lead rules on, and who settles escalations.

Graphyard can scale delivery through three formal slices — **product**, **infrastructure** and **docs/experience** (`docs-experience` in API data). A slice lead is a dedicated AI coordinator session with its own `slice-lead` principal.

## Authority boundaries

A lead may coordinate workers in its own slice, approve or reject plans, classify failures, request reruns, send work back and escalate. Every ruling is an immutable, append-only record carrying a versioned written rule ID and a reason, written with an `Idempotency-Key`.

A lead cannot implement, claim or renew a lease, submit evidence, review its own slice, change requirements or evidence definitions, bypass a gate, acquire merge execution or merge. Every lifecycle mutation from a `slice-lead` credential is refused and recorded as `lead.action.refused`; one aimed at another slice is recorded without a work item, naming the attempted action and target, so that slice's ledger stays untouched. A ruling against a delivered item is refused rather than bumping its revision.

## Blocking rulings and their recovery

`reject-plan` and `send-back` are not advice. Each records a **lead hold** in the transaction that appends the ruling: merge authorization is invalidated at once, the `merge` gate refuses with `Slice lead LEAD ruled ACTION under rule RULE; delivery is blocked until the authorized recovery: REASON`, and the guarded merge broker refuses the item independently of the stored gates. Holds are ranked, `send-back` over `reject-plan`, and a later ruling may raise a hold but never weakens one.

- `reject-plan`: A later `approve-plan` from the same lead naming the rejection it supersedes, as `"supersedes": "RULING-ID"`
- `send-back`: Only `graphyard rework GY-N --previous-worker-stopped REASON`, which reopens implementation. No ruling clears it

## Independent proof producers

Trusted evidence must come from a `producer` identity independent of both the implementation and the lead, bound to the exact head, base and policy revision. A submission is refused, and `evidence.producer.refused` recorded, when the submitting identity has ever held an assignment on that item, holds `slice-lead` authority for any slice, or is a producer bound to the item's own slice.

## Escalation

Four triggers raise an automatic, append-only escalation:

| Trigger | Raised when |
| --- | --- |
| `lease-loss` | A worker lease lapses on an epoch with no submission, no carried `blocked` report and no stopped-worker attestation: a worker that silently vanished. A lapse the ledger explains is a `lease.expired` history entry with its cause — `submitted` (the lease ended at `complete`), `blocked-awaiting-operator` (the worker reported `blocked` and stopped to wait), or `stopped-by-attestation` (an admin attested with `rework` or `recover-containment --previous-worker-stopped`) — and raises nothing |
| `evidence-policy-conflict` | Trusted evidence arrives for a policy revision other than the item's current one |
| `security-concern` | A lead files an `escalate` ruling naming this trigger |
| `requirement-weakening` | A requirement revision retires a criterion or narrows an existing criterion's required proofs |

### Who may settle what

| Standing escalation | Settled by |
| --- | --- |
| `lease-loss` raised by the control plane for an epoch whose lapse the ledger explains | Reconciliation, automatically; or any `admin` principal, whatever its declared session kind, with `resolve GY-N lease-loss --attestation blocked\|stopped-worker "reason"`. The server verifies the citation against the ledger for that exact epoch and refuses `The ledger holds no KIND attestation for epoch N` otherwise. A declared human session may also resolve it |
| `lease-loss` raised by the control plane for a lapse nothing explains | A declared human session only; a citation the ledger does not hold is refused, and nothing settles it automatically |
| `security-concern`, `requirement-weakening`, `evidence-policy-conflict`, and any `lease-loss` a lead raised | A declared human session only: an `admin` declaring `sessionKind: "ai"` or nothing is refused with `Escalation resolution requires a declared human session; PRINCIPAL is ai`, and a citation with `Only a lease-loss raised by the control plane is settled by citing an attestation` |

Every settlement is append-only history. A resolution records an `escalation.resolved` event keeping the incident verbatim with who resolved it, that principal's declared session kind, the reason and the attestation cited (or `null`). Reconciliation settles the rest itself, on deploy and every later tick, with an `escalation.auto-settled` entry naming the cause: `auto-settled: submitted before expiry` for an epoch with a bound submission, and `auto-settled: blocked report for epoch N explains the lapse` or `auto-settled: stopped-worker attestation for epoch N explains the lapse` for one the control plane raised. The attestation may arrive after the lapse, so a later `rework --previous-worker-stopped` for that epoch settles it next tick. A `lease-loss` a lead raised is never settled this way, and a lapse nothing explains stands until someone resolves it — auto-settlement never invents an explanation.

## Ownership, capacity and identity

Ownership is bound per claimed item: one worker identity, one lease epoch, one registered worktree, held only while its `watch` supervisor keeps renewing. A second identity claiming an owned item is refused with `Task already has an active owner`; a heartbeat, workspace, submission or release from another identity or epoch with `Lease missing, expired, or superseded`; a second worktree for the same assignment with `This assignment already has a workspace`; and a path or branch another assignment reserved as overlapping. A worker **may** hold several claimed items in a slice, each with its own epoch, worktree and history, while occupying one seat.

