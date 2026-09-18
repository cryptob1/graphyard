# Slice-lead delegation

Graphyard can scale delivery through three formal slices: **product**, **infrastructure**, and **docs/experience** (`docs-experience` in API data). A slice lead is a dedicated AI coordinator session with its own `slice-lead` principal and credential. It is not an implementation worker, reviewer, proof producer, or merge authority.

The original bootstrap flow is unchanged: one worker operates under direct human supervision, claims one item, registers one assigned worktree, and runs under `watch`. Slices are optional on existing items and do not make Herdr a source of control-plane truth.

## Authority boundaries

A lead may coordinate workers in its own slice, approve or reject plans, classify failures, request reruns, send work back, and escalate. Every ruling is an immutable, append-only record and requires both a versioned written rule ID and a reason.

A lead cannot implement, claim or renew a worker lease, submit evidence, review its own slice independently, change requirements or evidence definitions, bypass a gate, acquire merge execution, or merge. The server refuses every lifecycle mutation from a `slice-lead` credential and records the attempt as a `lead.action.refused` history entry. Graphyard owns assignments, lease epochs, worktree reservations, gates, evidence, and delivery; Herdr may only report runtime health.

Refusal logging obeys the same slice boundary as rulings. A refused request aimed at the lead's own slice is recorded against that work item. A refused request aimed at **another** slice is recorded without a work item, naming both the attempted action and the target (`targetKey`, `targetSlice`) alongside the lead's own slice, so the attempt stays in history while the other slice's ledger, revision, and aggregate remain untouched.

Delivered work is an immutable snapshot. A ruling against an item in `done` is refused rather than bumping its revision or attaching new escalation state to it; record the finding as a follow-up task instead.

Rulings and intake are written with an `Idempotency-Key`. Retrying the identical request returns the original ruling or intake item; reusing a key with different input is refused. A lost response therefore never duplicates an immutable ruling, intake item, or history entry.

Humans retain goals, priorities, policy and requirement changes, evidence-definition changes, waivers, destructive or exceptional promotions, and ambiguity resolution. Routine intake from explicit feedback, recorded defects, unfinished dependencies, and verification findings may enter the backlog automatically. Leads must escalate security concerns, suspected requirement weakening, evidence-policy conflict, and lease loss; these escalations cannot be suppressed.

## Independent proof producers

Trusted evidence must come from a `producer` identity that is independent of both the implementation and the lead, and it stays bound to the exact head SHA, base SHA, and policy revision of the candidate. The server refuses an evidence submission, and records an `evidence.producer.refused` history entry, when the submitting identity:

- has ever held an assignment on that item, including superseded epochs and earlier workers whose attempt was reworked;
- holds `slice-lead` authority for any slice; or
- is a producer credential bound to the item's own slice.

Configuration is checked the same way at startup: a producer credential may not reuse a lead's principal ID and may not declare a `slice`, because review/proof agents are shared and slice-independent. Workers may still record their own untrusted assertions — they appear as worker assertions and never satisfy an acceptance gate.

## Escalation

Four triggers raise an automatic, append-only escalation on the work item:

| Trigger | Raised when |
| --- | --- |
| `lease-loss` | Reconciliation observes an expired worker lease, or a replacement claim takes over one. |
| `evidence-policy-conflict` | Trusted evidence arrives for a policy revision other than the item's current one. |
| `security-concern` | A lead files an `escalate` ruling naming this trigger. |
| `requirement-weakening` | A requirement revision retires a criterion or narrows an existing criterion's required proofs. |

A standing escalation is never overwritten, reclassified, or cleared by a later lead ruling; leads have no path to silence one. An `escalate` ruling must name its trigger, and no other ruling action may carry one.

Lease loss is recorded wherever it is observed: by reconciliation when a lease expires, and by the replacement claim itself, which records the expired owner and epoch in the same transaction that overwrites the lease. A replacement can therefore never erase the evidence that an assignment was lost.

### An unresolved escalation refuses delivery

While an escalation stands, the `merge` gate refuses with `Unresolved TRIGGER escalation requires operator resolution: REASON`, and raising one invalidates any existing merge authorization in the same transaction. The guarded merge broker applies the same rule independently, so an already merge-ready candidate stops being selectable the moment it is escalated.

Only the human operator clears one, with `graphyard resolve GY-N TRIGGER "audit reason"` (`POST /api/work/UUID/resolve`). The request must name the standing trigger, so a stale client cannot clear a newer escalation it never read, and the resolution is itself append-only history carrying its reason. No lead, worker, producer, coordinator, or scoped operator agent may resolve an escalation. Merge authorization is reissued only after the gates pass again.

## Capacity and identity

Defaults are three slice leads, two active engineers per slice lead, and one to two shared independent review/proof agents. Capacity is measured in **engineers**, not leases: an engineer holding two items in a slice appears as two claimed items but occupies one seat, and the claim check refuses only when a distinct additional engineer would exceed the limit. The server reads positive integer overrides from `GRAPHYARD_MAX_SLICE_LEADS`, `GRAPHYARD_MAX_ENGINEERS_PER_LEAD`, `GRAPHYARD_MIN_REVIEWERS`, and `GRAPHYARD_MAX_REVIEWERS`; it refuses configurations or claims above those limits with an explicit reason. Once any slice lead is configured, at least `GRAPHYARD_MIN_REVIEWERS` independent review/proof agents are required; bootstrap, which has no leads, needs none.

Lead credentials use `role: "slice-lead"`, `sessionKind: "ai"`, and one of the formal `slice` identifiers. Principal IDs and bearer tokens remain globally unique, and two leads may not share a token. Declare `sessionKind` on every credential: an undeclared session is reported and displayed as undeclared rather than assumed to be human.

## What the dashboard shows

The **Delivery slices** panel renders one card per formal slice. Each card shows the slice's lead by display name and principal ID with that lead's declared session kind, or `No lead assigned` and `Unassigned` when the slice has no lead; distinct active engineers against the configured per-lead limit, alongside the claimed-item count they hold; each active worker by work key and identity with its own session kind; and each bottleneck by work key with the blocker, escalation, or first refusing gate reason. Below the cards, the shared independent review/proof sessions are listed by identity and session kind. The signed-in session states its own principal, role, and session kind in the sidebar.

## Scoped reads

`GET /api/delegation` and the `delegation` block inside `GET /api/status` are reads over work items, so they are filtered by exactly the scope rule that governs every other read. A scoped operator agent sees only its own work items and never the owners, engineers, workers, or bottlenecks of work outside that scope. Intake authorizes the same way: a cited `sourceWorkId` must be inside the caller's scope, and a slice lead may cite only its own slice. Existence is not authority, so an out-of-scope citation is refused before anything is appended to that item's history.

## Ordering and conflicts

Delivery order is recomputed on every guarded merge batch from current dependencies, planned/observed path overlap, exclusive-resource reservations, priority, and stable work keys. It is not registration order. The guarded merge broker remains the sole merge path and revalidates the exact candidate immediately before merging.
