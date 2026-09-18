# Slice-lead delegation

Graphyard can scale delivery through three formal slices: **product**, **infrastructure**, and **docs/experience** (`docs-experience` in API data). A slice lead is a dedicated AI coordinator session with its own `slice-lead` principal and credential. It is not an implementation worker, reviewer, proof producer, or merge authority.

The original bootstrap flow is unchanged: one worker operates under direct human supervision, claims one item, registers one assigned worktree, and runs under `watch`. Slices are optional on existing items and do not make Herdr a source of control-plane truth.

## Authority boundaries

A lead may coordinate workers in its own slice, approve or reject plans, classify failures, request reruns, send work back, and escalate. Every ruling is an immutable, append-only record and requires both a versioned written rule ID and a reason.

A lead cannot implement, claim or renew a worker lease, submit evidence, review its own slice independently, change requirements or evidence definitions, bypass a gate, acquire merge execution, or merge. The server refuses every lifecycle mutation from a `slice-lead` credential and records the attempt as a `lead.action.refused` history entry. That holds for every mutating work route, whichever handler matches first: the merge-broker routes (`merge-acquire`, `merge-cancel`, `merge-verify`) record their own refusal, and work creation, which names no existing item, is recorded unscoped with a null `targetKey` rather than dropped for want of a ledger to append to. Graphyard owns assignments, lease epochs, worktree reservations, gates, evidence, and delivery; Herdr may only report runtime health.

Refusal logging obeys the same slice boundary as rulings. A refused request aimed at the lead's own slice is recorded against that work item. A refused request aimed at **another** slice is recorded without a work item, naming both the attempted action and the target (`targetKey`, `targetSlice`) alongside the lead's own slice, so the attempt stays in history while the other slice's ledger, revision, and aggregate remain untouched.

Delivered work is an immutable snapshot. A ruling against an item in `done` is refused rather than bumping its revision or attaching new escalation state to it; record the finding as a follow-up task instead.

Rulings and intake are written with an `Idempotency-Key`. Retrying the identical request returns the original ruling or intake item; reusing a key with different input is refused. A lost response therefore never duplicates an immutable ruling, intake item, or history entry.

Humans retain goals, priorities, policy and requirement changes, evidence-definition changes, waivers, destructive or exceptional promotions, and ambiguity resolution. Those human-only origins require a **declared human session**, not merely an administrative role: an `admin` credential that declares `sessionKind: "ai"`, or declares nothing at all, is refused with `ORIGIN intake requires a declared human session; PRINCIPAL is ai|undeclared`. Routine intake from explicit feedback, recorded defects, unfinished dependencies, and verification findings may enter the backlog automatically, and that routine path is unchanged for every intake-capable credential, so operator automation and the single-agent bootstrap flow keep working without declaring a session kind. Leads must escalate security concerns, suspected requirement weakening, evidence-policy conflict, and lease loss; these escalations cannot be suppressed.

## Blocking rulings and their recovery

`reject-plan` and `send-back` are not advice. Each one records a **lead hold** on the work item in the same transaction that appends the ruling: merge authorization is invalidated immediately, the `merge` gate refuses with `Slice lead LEAD ruled ACTION under rule RULE; delivery is blocked until the authorized recovery: REASON`, and the guarded merge broker refuses the item independently of the stored gates. A merge-ready candidate that its slice lead rejects or sends back therefore stops being deliverable at once, and the hold is durable state that survives re-observation and reconciliation — re-evaluation never quietly reissues authorization while it stands.

Holds are ranked, `send-back` over `reject-plan`, and a later ruling may raise a hold but never weakens one. There are exactly two authorized recoveries:

| Standing hold | Authorized recovery |
| --- | --- |
| `reject-plan` | A later `approve-plan` ruling from the same slice lead that names the rejection it supersedes, as `"supersedes": "RULING-ID"`. |
| `send-back` | Only `graphyard rework GY-N --previous-worker-stopped REASON` from the human operator, which reopens implementation. No ruling clears it. |

An approval is bound to the rejection it clears. `approve-plan` releases a hold only when its `supersedes` names the standing rejection's own ruling ID, and only for the lead that raised it; an approval naming any other ruling is refused with `Standing plan rejection is ruling RULING-ID; reload before approving`. An `approve-plan` sent while a rejection of that lead stands but naming nothing is refused as well, so a rejection never falls away silently. A delayed approval prepared against an earlier rejection therefore cannot clear a newer one that it never read, and only `approve-plan` may carry `supersedes`. Any ruling may additionally carry `expectedRevision` to pin the work revision it was decided against.

Clearing a hold removes its refusal from the `merge` gate but does not mint merge authorization: only a full gate evaluation may do that, so delivery resumes only once every other gate passes again on the observed candidate. A held item appears as a slice bottleneck naming the ruling that blocked it.

## Independent proof producers

Trusted evidence must come from a `producer` identity that is independent of both the implementation and the lead, and it stays bound to the exact head SHA, base SHA, and policy revision of the candidate. The server refuses an evidence submission, and records an `evidence.producer.refused` history entry, when the submitting identity:

- has ever held an assignment on that item, including superseded epochs and earlier workers whose attempt was reworked;
- holds `slice-lead` authority for any slice; or
- is a producer credential bound to the item's own slice.

Independence is a standing property, not a one-time check at submission. The implementer set is append-only, so if a producer identity later takes an assignment on the item — for example by claiming during rework — every trusted proof it produced for that candidate stops being applicable at the next gate evaluation. Acceptance refuses with `Trusted PROOF evidence from PRODUCER is no longer independent: PRODUCER has since held an assignment on GY-N`, merge authorization is dropped, and the broker refuses the item independently. Nothing is rewritten: the evidence row stays in history exactly as produced, and resubmitting the unchanged candidate does not revive it. The item becomes acceptable again only when a producer that is still independent of every implementer proves the required proofs afresh.

Configuration is checked the same way at startup: a producer credential may not reuse a lead's principal ID and may not declare a `slice`, because review/proof agents are shared and slice-independent. Workers may still record their own untrusted assertions — they appear as worker assertions and never satisfy an acceptance gate.

## Escalation

Four triggers raise an automatic, append-only escalation on the work item:

| Trigger | Raised when |
| --- | --- |
| `lease-loss` | Reconciliation observes an expired worker lease, a replacement claim takes over one, or operator rework discards one. |
| `evidence-policy-conflict` | Trusted evidence arrives for a policy revision other than the item's current one. |
| `security-concern` | A lead files an `escalate` ruling naming this trigger. |
| `requirement-weakening` | A requirement revision retires a criterion or narrows an existing criterion's required proofs. |

A standing escalation is never overwritten, reclassified, or cleared by a later lead ruling; leads have no path to silence one. An `escalate` ruling must name its trigger, and no other ruling action may carry one.

Each trigger stands on its own. A later distinct concern — a `security-concern` raised while a `lease-loss` still stands — is recorded alongside the standing one rather than dropped behind it, and every standing trigger refuses the `merge` gate with its own reason until it is individually resolved. A repeat of a trigger that already stands is history, not a second incident, so there is at most one unresolved escalation per trigger. Readers see every unresolved concern in `escalations`; `escalation` mirrors the oldest one.

Lease loss is recorded wherever an assignment is discarded, not only where it expires: by reconciliation when a lease runs out, by the replacement claim itself, which records the expired owner and epoch in the same transaction that overwrites the lease, and by operator `rework`, which clears the lease outright. Rework is the last point at which that loss is visible — reconciliation afterwards sees no lease to expire, and the replacement claim reads a lease that is already `null` — so a worker stopped after submitting, which never released its own lease, has the incident recorded against the epoch it belonged to, with `lastAssignment` still naming the worker that held it. The operator's `previousWorkerStopped` attestation authorizes the reassignment; it does not decide whether the incident is recorded. Rework that discards no lease raises nothing. A replacement can therefore never erase the evidence that an assignment was lost, and the replacement worker may claim and work the reopened item while the escalation stands, though delivery waits on a declared human session resolving it.

### An unresolved escalation refuses delivery

While an escalation stands, the `merge` gate refuses with `Unresolved TRIGGER escalation requires operator resolution: REASON`, and raising one invalidates any existing merge authorization in the same transaction. The guarded merge broker applies the same rule independently, so an already merge-ready candidate stops being selectable the moment it is escalated.

Only the human operator clears one, with `graphyard resolve GY-N TRIGGER "audit reason"` (`POST /api/work/UUID/resolve`). The request must name one standing trigger and carry `expectedRevision`, the work revision the operator actually read; a stale client therefore cannot clear a later incident that happens to share a trigger, and clearing one concern leaves every other standing trigger refusing delivery. The resolution is itself append-only history carrying its reason.

Resolution is decided from the declared session, not from the `admin` role, exactly as human-only intake is: an `admin` credential declaring `sessionKind: "ai"` or declaring nothing is refused with `Escalation resolution requires a declared human session; PRINCIPAL is ai`. No lead, worker, producer, coordinator, or scoped operator agent may resolve an escalation. Merge authorization is reissued only after the gates pass again.

### A concern raised mid-merge fences the execution

Raising an escalation or a blocking ruling also **fences** any merge execution in flight, in the same transaction, and wakes reconciliation instead of waiting for the execution's own expiry. A fenced execution can no longer be verified or resumed, and the guarded merge broker re-reads the work item immediately before calling GitHub — after final verification and the clock-ordering delay — refusing the provider call unless the execution still stands unfenced and every gate still passes. A lead `escalate` or `send-back` that lands between verification and the merge call therefore stops the delivery it refuses. The execution row itself is kept rather than deleted, so its owning coordinator can still cancel it idempotently and is never stranded.

Lease loss reaches the record the same way: reconciliation records an expired lease and raises its escalation even while a merge execution is active, rather than deferring until the execution ends.

## Ownership and worktrees

Ownership is bound per claimed item, not per worker. Every claimed item is held by exactly one worker identity under one lease epoch, is implemented in exactly one registered worktree for that assignment, and stays claimed only while its `watch` supervisor keeps renewing the lease. The server enforces each part of that binding: a second identity claiming an owned item is refused with `Task already has an active owner`; a heartbeat, workspace, submission, or release from any other identity or epoch is refused with `Lease missing, expired, or superseded`; a second worktree for the same assignment is refused with `This assignment already has a workspace`; and a worktree path or branch that another assignment has already registered — including another item held by the same engineer — is refused as reserved or overlapping. When the supervisor stops renewing, reconciliation clears the lease on the server's clock, records a `lease-loss` escalation that only a declared human session can resolve, keeps the lost owner and epoch in `lastAssignment`, and leaves the item claimable by a replacement under a new epoch.

A worker **may** hold more than one claimed item in a slice. Each of those items keeps its own lease epoch, its own registered worktree, and its own history, and the engineer occupies a single seat under the slice lead for all of them. The single-agent bootstrap flow, in which one worker claims one item, is the one-item case of the same rule.

## Capacity and identity

Defaults are three slice leads, two active engineers per slice lead, and one to two shared independent review/proof agents. Capacity is measured in **engineers**, not leases: an engineer holding two items in a slice appears as two claimed items but occupies one seat, and the claim check refuses only when a distinct additional engineer would exceed the limit. The server reads positive integer overrides from `GRAPHYARD_MAX_SLICE_LEADS`, `GRAPHYARD_MAX_ENGINEERS_PER_LEAD`, `GRAPHYARD_MIN_REVIEWERS`, and `GRAPHYARD_MAX_REVIEWERS`; it refuses configurations or claims above those limits with an explicit reason. Once any slice lead is configured, at least `GRAPHYARD_MIN_REVIEWERS` independent review/proof agents are required; bootstrap, which has no leads, needs none.

Lead credentials use `role: "slice-lead"`, `sessionKind: "ai"`, and one of the formal `slice` identifiers. Declare `sessionKind: "human"` on the operator credential a person actually uses, because human-only intake is decided from that declaration rather than from the `admin` role. Principal IDs and bearer tokens are checked for global uniqueness across the whole roster, not only among leads: a lead sharing an ID or credential with a worker, coordinator, or producer is one identity holding two authorities. Declare `sessionKind` on every credential: an undeclared session is reported and displayed as undeclared rather than assumed to be human.

## What the dashboard shows

The **Delivery slices** panel renders one card per formal slice. Each card shows the slice's lead by display name and principal ID with that lead's declared session kind, or `No lead assigned` and `Unassigned` when the slice has no lead; distinct active engineers against the configured per-lead limit, alongside the claimed-item count they hold; each active worker by work key and identity with its own session kind; and each bottleneck by work key with the blocker, escalation, or first refusing gate reason. Below the cards, the shared independent review/proof sessions are listed by identity and session kind. The signed-in session states its own principal, role, and session kind in the sidebar.

## Scoped reads

`GET /api/delegation` and the `delegation` block inside `GET /api/status` are reads over work items, so they are filtered by exactly the scope rule that governs every other read. A scoped operator agent sees only its own work items and never the owners, engineers, workers, or bottlenecks of work outside that scope. Intake authorizes the same way: a cited `sourceWorkId` must be inside the caller's scope, and a slice lead may cite only its own slice. Existence is not authority, so an out-of-scope citation is refused before anything is appended to that item's history.

## Ordering and conflicts

Delivery order is recomputed on every guarded merge batch from current dependencies, planned/observed path overlap, exclusive-resource reservations, priority, and stable work keys. It is not registration order. The guarded merge broker remains the sole merge path and revalidates the exact candidate immediately before merging.
