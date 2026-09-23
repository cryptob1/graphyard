<!-- page: Understand or contribute | 1 | invariants, boundaries. -->
# Architecture and correctness model

For a contributor: what makes a gate decision trustworthy.

## Boundary

Graphyard owns coordination decisions; a gate is a deterministic evaluation, never a model's judgment.

![Graphyard control-plane components; the text equivalent follows.](diagrams/control-plane-components.svg)

Text equivalent: agent sessions, the dashboard and a proof producer reach the **HTTP API and CLI**, which hands authenticated commands to the **coordination engine** — one advisory-locked transaction per mutation, no external I/O inside — writing the aggregate and its event together to **Postgres**. Jobs flow to the **reconciliation worker**, which exchanges pull-request, review, check, protection and merge facts with **GitHub**; the dashed arrow back is the signed webhook waking a job.

## Storage

- **`work_items.document`:** the current aggregate; each mutation updates it, appending an event carrying the new snapshot in the same transaction, ordered by `events.seq`.
- **Release, delivery, attribution and validation tables:** those protocols' immutable records.
- **`flow_facts` and `deployment_observations`:** the append-only projection [flow analytics](flow-analytics.md) reads, never part of gate evaluation.

## Transactions, assignments and evidence

- **Requirements and dependency edges:** revisable by [audited revision](coordination.md#revise-requirements-explicitly), refusing active ownership and cycles.

## Inverted coordination: typed actions and stateless executors

The control plane names what each item needs next and keeps a durable leased row for it; stateless executors claim those rows and run them ([operating them](executors.md)). `nextAction` (`src/model/next-action.ts`) is pure over the item, its graph and the clock, so two readers always agree without talking to each other.

- **Every gate refusal maps to exactly one of the nine kinds** through `refusalAction`, whose last rule matches everything, so an unmapped refusal escalates rather than going silent. An unfinished dependency and a queue position name no action of their own: they are the other item's `dispatch` and the predecessor's `merge`. Naming an action nobody can complete is the failure this prevents.
- **A refusal is classified from the item, not its text:** `reviewNeed` and `reviewStandstill` decide what a review refusal needs — a standing change request `request-rework`; a head not containing the base tip, or a provider that dispatches its own review (`codex`, `agent`), `resync`; a base that would not merge `request-rework`; an exhausted reviewer roster, or an unsettled fence with no live lease, `escalate`; a genuinely missing `github` approval `request-review`. `reclaim` clears a lapsed lease but never lowers a fence, so its handler refuses rather than reporting a fenced item free.
- **Rows are durable** (`src/model/actions.ts`), written in the same advisory-locked transaction as every other decision; a row's id hashes what it binds, never when it was made, so a restart recognises the row it has. Executors are stateless — a credential, a host name, one handler per kind — and `actionJudgment` classifies each kind (`none` mechanical, `in-session` launches a session the model works inside, `in-step` *is* the judgment), the two `in-step` kinds never having a handler, so a ready-to-delivered cycle runs with no judgment in the loop; `llmRole` names the judgment inside what an action starts.
- **A claim is a bounded lease, not a bounded handler:** an executor still working renews it, and a renewal is accepted only from the live claim's own executor name *and* credential, since several executors may share one coordinator credential. One that dies renews nothing, its claim expires, the next takes the row as a further attempt, and the dead one's late settlement is refused. A row whose claim is live is never retired even when the situation moved on.

None of this authorizes progression: an action is a fact about what is missing, and the gates still decide from evidence and verdicts alone.

## Reconciliation

- **Job eligibility:** a successful job again after 20 seconds, a failed one after 45.
- **Check publication:** rechecks that token, the revision and observation freshness immediately before writing.
- **Adapter:** rereads the pull request after collecting evidence, refusing a changed head, base, draft or state.
- **Observations older than two minutes:** refuse the merge gate.

## The merge execution boundary

- **Before a merge completes work:** Graphyard must hold an authorization for the same head, base and policy, and a final GitHub verification under a short-lived, single-use execution authority.
- **Refused while active:** requirement, evidence, validation, reconciliation and non-matching observation mutations.
- **Sole exception:** [evidence revocation](protocol/evidence.md#revocation), cancelling the authority in the transaction withdrawing the evidence.

## Display state and replicas

- **Delivered work:** stays delivered in history; a merge observed with unsatisfied gates is a permanent visible violation.
