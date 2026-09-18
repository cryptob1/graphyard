# Slice-lead delegation

Graphyard can scale delivery through three formal slices: **product**, **infrastructure**, and **docs/experience** (`docs-experience` in API data). A slice lead is a dedicated AI coordinator session with its own `slice-lead` principal and credential. It is not an implementation worker, reviewer, proof producer, or merge authority.

The original bootstrap flow is unchanged: one worker operates under direct human supervision, claims one item, registers one assigned worktree, and runs under `watch`. Slices are optional on existing items and do not make Herdr a source of control-plane truth.

## Authority boundaries

A lead may coordinate workers in its own slice, approve or reject plans, classify failures, request reruns, send work back, and escalate. Every ruling is an immutable, append-only record and requires both a versioned written rule ID and a reason.

A lead cannot implement, claim or renew a worker lease, submit evidence, review its own slice independently, change requirements or evidence definitions, bypass a gate, acquire merge execution, or merge. The server refuses every lifecycle mutation from a `slice-lead` credential and records the attempt against that item as a `lead.action.refused` history entry. Graphyard owns assignments, lease epochs, worktree reservations, gates, evidence, and delivery; Herdr may only report runtime health.

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
| `lease-loss` | Reconciliation observes an expired worker lease. |
| `evidence-policy-conflict` | Trusted evidence arrives for a policy revision other than the item's current one. |
| `security-concern` | A lead files an `escalate` ruling naming this trigger. |
| `requirement-weakening` | A requirement revision retires a criterion or narrows an existing criterion's required proofs. |

A standing escalation is never overwritten, reclassified, or cleared by a later lead ruling; leads have no path to silence one. An `escalate` ruling must name its trigger, and no other ruling action may carry one.

## Capacity and identity

Defaults are three slice leads, two active engineers per slice lead, and one to two shared independent review/proof agents. The server reads positive integer overrides from `GRAPHYARD_MAX_SLICE_LEADS`, `GRAPHYARD_MAX_ENGINEERS_PER_LEAD`, `GRAPHYARD_MIN_REVIEWERS`, and `GRAPHYARD_MAX_REVIEWERS`; it refuses configurations or claims above those limits with an explicit reason. Once any slice lead is configured, at least `GRAPHYARD_MIN_REVIEWERS` independent review/proof agents are required; bootstrap, which has no leads, needs none.

Lead credentials use `role: "slice-lead"`, `sessionKind: "ai"`, and one of the formal `slice` identifiers. Principal IDs and bearer tokens remain globally unique, and two leads may not share a token. Declare `sessionKind` on every credential: an undeclared session is reported and displayed as undeclared rather than assumed to be human.

## What the dashboard shows

The **Delivery slices** panel renders one card per formal slice. Each card shows the slice's lead by display name and principal ID with that lead's declared session kind, or `No lead assigned` and `Unassigned` when the slice has no lead; active engineers against the configured per-lead limit; each active worker by work key and identity with its own session kind; and each bottleneck by work key with the blocker, escalation, or first refusing gate reason. Below the cards, the shared independent review/proof sessions are listed by identity and session kind. The signed-in session states its own principal, role, and session kind in the sidebar.

## Ordering and conflicts

Delivery order is recomputed on every guarded merge batch from current dependencies, planned/observed path overlap, exclusive-resource reservations, priority, and stable work keys. It is not registration order. The guarded merge broker remains the sole merge path and revalidates the exact candidate immediately before merging.
