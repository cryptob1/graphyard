# Slice-lead delegation

Graphyard can scale delivery through three formal slices: **product**, **infrastructure**, and **docs/experience** (`docs-experience` in API data). A slice lead is a dedicated AI coordinator session with its own `slice-lead` principal and credential. It is not an implementation worker, reviewer, proof producer, or merge authority.

The original bootstrap flow is unchanged: one worker operates under direct human supervision, claims one item, registers one assigned worktree, and runs under `watch`. Slices are optional on existing items and do not make Herdr a source of control-plane truth.

## Authority boundaries

A lead may coordinate workers in its own slice, approve or reject plans, classify failures, request reruns, send work back, and escalate. Every ruling is an immutable, append-only record and requires both a versioned written rule ID and a reason.

A lead cannot implement, claim or renew a worker lease, submit trusted evidence, review its own slice independently, change requirements or evidence definitions, bypass a gate, acquire merge execution, or merge. The server enforces these boundaries. Graphyard owns assignments, lease epochs, worktree reservations, gates, evidence, and delivery; Herdr may only report runtime health.

Humans retain goals, priorities, policy and requirement changes, evidence-definition changes, waivers, destructive or exceptional promotions, and ambiguity resolution. Routine intake from explicit feedback, recorded defects, unfinished dependencies, and verification findings may enter the backlog automatically. Leads must escalate security concerns, suspected requirement weakening, evidence-policy conflict, and lease loss; these escalations cannot be suppressed.

## Capacity and identity

Defaults are three slice leads, two active engineers per slice lead, and one to two shared independent review/proof agents. The server reads positive integer overrides from `GRAPHYARD_MAX_SLICE_LEADS`, `GRAPHYARD_MAX_ENGINEERS_PER_LEAD`, `GRAPHYARD_MIN_REVIEWERS`, and `GRAPHYARD_MAX_REVIEWERS`; it refuses configurations or claims above those limits with an explicit reason.

Lead credentials use `role: "slice-lead"`, `sessionKind: "ai"`, and one of the formal `slice` identifiers. Principal IDs and bearer tokens remain globally unique. Trusted evidence must come from a `producer` identity distinct from the implementer and the lead and remains bound to the exact head SHA, base SHA, and policy revision.

The dashboard labels human and AI roles, lists each slice's lead and active workers, shows the shared reviewer pool, and surfaces blocked items as bottlenecks.

## Ordering and conflicts

Delivery order is calculated from current dependencies, planned/observed path overlap, exclusive-resource reservations, priority, and stable work keys. It is not registration order. The guarded merge broker remains the sole merge path and revalidates the exact candidate immediately before merging.
