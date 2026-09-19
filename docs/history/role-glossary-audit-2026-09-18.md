# Role-glossary audit — September 18, 2026

> **Historical record.** This audit records how the [glossary](../glossary.md) was applied across the documentation after GY-28 (role clarifications in *How Graphyard works*) and GY-31 (slice-lead delegation) landed. Use the [current documentation index](../README.md) for setup and operations.

## Scope

Every user-facing Markdown document rendered on GitHub and in the in-app docs was read for ambiguous or inconsistent references to *Operator*, *Master*, *Worker*, *Reviewer/proof producer*, *agent*, *session*, *principal*, *Herdr*, *Graphyard*, and *human*: `README.md` and all 22 pages under `docs/` (the two earlier `docs/history/` records are historical snapshots and were left as written). The glossary defines eight distinctions and one canonical usage each; the rewrites below apply them.

Method: each page was read in full; every occurrence of the audited words was classified as *unambiguous under the glossary* (bare *operator* is the human operator; bare *worker*, *master*, *reviewer*, *producer* name a role), *ambiguous* (which of two glossary senses is meant is not clear from the sentence), or *inconsistent* (a term used in a sense the glossary reserves for another word). Ambiguous and inconsistent instances are listed with their rewrite. The GY-28 sentences that the browser regression `browser-tests/dashboard.spec.ts` asserts verbatim, and the GY-31 text in `docs/delegation.md`, were kept unchanged (see [overlap](#gy-28-and-gy-31-integration)).

## Ambiguity audit and rewrites

| Page | Before | After | Reason |
| --- | --- | --- | --- |
| `README.md` | "Agent runtimes write code." | "Agent sessions, hosted by runtimes such as Herdr, write the code." | A runtime hosts sessions; it does not write code. |
| `README.md` | "**Agent runtimes** own live sessions. **Trusted runners** produce allowed evidence." | "**Agent runtimes** such as Herdr own live agent sessions. **Proof producers** (CI workflows and trusted runners) produce trusted evidence." | *Trusted runner* is one kind of proof producer. |
| `README.md` | "Codex, Claude, OpenCode, custom agents, and humans" | "Codex, Claude Code, opencode, custom agents, and human operators" | Bare *humans* hides who holds authority. |
| `README.md`, `quickstart.md` | "the operator token from `.env`" | "the `admin` token … the human operator's credential" | *Operator token* could be read as the operator-agent credential. |
| `how-graphyard-works.md` | "Agent runtimes such as Herdr help run the sessions" | "Agent runtimes such as Herdr run the sessions … defined once in the glossary" | Runtimes run sessions; nothing else does. |
| `how-graphyard-works.md` | "An operator connects the repository … individual identities" | "The human operator connects the repository … one principal per session" | *Operator* vs operator agent; *identity* vs principal. |
| `how-graphyard-works.md` | "A worker claims the ready item under its own identity … waits for that assigned workspace" | "under its own principal … waits for that assigned worktree" | Canonical terms. |
| `how-graphyard-works.md` | "External tools may run the session, but they do not own the assignment." | "A runtime such as Herdr may host the session, but it does not own the assignment." | *External tools* was undefined. |
| `how-graphyard-works.md` | "The configured independent reviewer … the implementation worker" | "The independent reviewer … the worker" | One name per role. |
| `how-graphyard-works.md` | "Authorized proof producers report" | "Proof producers with a live grant report" | Authority is a grant, not configuration. |
| `how-graphyard-works.md` | "a healthy Herdr session does not prove ownership" | "a healthy session does not prove ownership" | Sessions belong to a runtime; *Herdr session* implied a second kind. |
| `architecture.md` | "Herdr owns agent sessions. Test runners produce evidence." | "Herdr and other agent runtimes host agent sessions. Proof producers produce evidence." | Herdr is one runtime; *test runner* is one kind of producer. |
| `architecture.md` | "Evidence carries producer identity … an allowlist of exact proof names. Operators may attest `manual:` proofs, but cannot use an operator token" | "Evidence carries the producer principal … a live grant of exact proof names or bounded patterns. The human operator may attest `manual:` proofs, but cannot use an `admin` token" | Matches the shipped grant model and names the credential. |
| `architecture.md` | "operator-revisable" | "revisable by the human operator (or, additively, by a scoped operator agent)" | Both roles may revise; only one may remove. |
| `onboarding.md` | Mermaid box "Operator"; "Reviewer and trusted runner" | Rendered diagram with *human operator*, *reviewer*, *proof producer* and a text equivalent | The old box did not say which operator. |
| `onboarding.md` | "a human administrator may optionally configure … keeps Operator, Master, Worker, and Reviewer/proof-producer as four distinct AI sessions" | "the human operator may optionally configure … keeps operator agent, master, worker, and reviewer/proof producer as four distinct AI agent sessions" | *Operator* in a list of AI sessions is the operator agent. |
| `onboarding.md` | Role table without holders: "`admin` \| Setup…", "`producer` \| Only the proof names that runner may submit" | Role table with a *Held by* column: "`admin` \| The human operator; declare `sessionKind: "human"`", "`producer` \| A proof producer (CI or trusted runner) \| Only the proof names its grant allows" | Role, holder, and credential were conflated. |
| `onboarding.md` | "expose its merge-capable GitHub CLI credentials to implementation agents" | "… to worker sessions" | Role name, not program kind. |
| `onboarding.md` | "use a separate admin-authenticated operator session to inspect and submit it" | "the human operator inspects and submits it from a separate `admin`-authenticated terminal or dashboard sign-in" | *Operator session* read as an agent session. |
| `onboarding.md` | "requires an operator to deploy the server, provision identities" | "requires the human operator to deploy the server, provision principals" | Canonical terms. |
| `herdr.md` | "Herdr runs visible agent sessions." | "Herdr is the runtime that launches, shows, and stops agent sessions." | States the runtime distinction. |
| `herdr.md` | "It does not prove an agent started … the assigned workspace … Run workers under lease supervision" | "It does not prove a session started … the assigned worktree … Run worker sessions under lease supervision" | Session vs agent; worktree vs workspace. |
| `herdr.md` | "only after the worker's authenticated claim" | "only after the worker principal's authenticated claim" | Attribution is to the principal. |
| `herdr.md` | "The authenticated principal still determines ownership." | "The authenticated principal, not the label or the runtime, determines ownership." | Says what the alternatives were. |
| `herdr.md` | "race two identities for one item" | "race two worker principals for one item" | Canonical term. |
| `quickstart.md` | "Review the proposal with the operator" | "The human operator reviews the proposal" | Which operator. |
| `quickstart.md` | "Only an admin can revise requirements" | "Only the human operator's `admin` credential (or, additively, a scoped operator agent) can revise requirements" | Role and holder. |
| `quickstart.md` | "A trusted producer—not the implementation worker—submits" | "A proof producer—never the worker—submits" | Canonical terms, stronger modal. |
| `coordination.md` | "Herdr owns processes." | "Herdr owns session processes." | Which processes. |
| `coordination.md` | "Operators can use **Revise requirements**"; "Only an operator may revise requirements" | "The human operator can use…"; "Only the human operator's `admin` credential may revise requirements this way (a scoped operator agent may only add)" | Which operator; the operator agent's additive path. |
| `coordination.md` | "two distinct worker principals, and an operator … Keep operator and producer credentials off both worker environments" | "… and the human operator … Keep `admin` and `producer` credentials off both worker environments" | Names the credential. |
| `development.md` | "static UI, worker loop"; "process supervision"; "before an implementation agent claims it" | "reconciliation worker"; "session supervision"; "before a worker claims it" | *Worker loop* collided with worker sessions. |
| `first-pr.md` | "an operator inspects them and attests the proof from a separate admin session" | "the human operator inspects them and attests the proof from a separate `admin`-authenticated terminal" | *Admin session* read as an agent session. |
| `deployment.md` | "JSON array of individual operator, coordinator, worker, reader, and proof-producer credentials" | "JSON array of principals: the human operator's `admin`, the master's `coordinator`, `slice-lead`, `worker`, `reader`, and `producer` credentials, each with a `sessionKind`" | Lists the shipped roles, including `slice-lead`. |
| `deployment.md` | "This identity can read control-plane state but cannot claim work" | "This principal can read control-plane state and request the guarded merge but cannot claim work" | Names what the coordinator may do. |
| `deployment.md` | "just so agents can connect; agents use the HTTP API" | "just so agent sessions can connect; sessions use the HTTP API" | Canonical term. |
| `protocol.md` | Roles table lacked `slice-lead`; "operator only" on `requirements`, `rework`, `recover`, `reviewpolicy`; "Operators send `{}`" | Added the `slice-lead` row and a page-level note that *operator* means the human operator's `admin` credential; `requirements` and `reviewpolicy` now name the operator-agent capability that also permits them; `rework`/`recover` say `admin` only; "An `admin` sends `{}`" | The table was incomplete and *operator only* was wrong where an operator agent is also permitted. |
| `protocol.md` | "Each independent worker process should have a distinct principal; sharing a token makes processes indistinguishable" | "Each concurrent worker session must have its own principal; sharing a token makes sessions indistinguishable" | Session, and a requirement rather than a suggestion. |
| `protocol.md` | "`watch` requires a `worker` credential, even though operators may use manual claim commands" | "… even though the human operator's `admin` credential may use the manual claim commands" | Which operator, which credential. |
| `validation.md` | "Operator \| `admin`"; "Implementation agent \| `worker`"; "an operator-created runner registration" | "Human operator \| `admin`"; "Worker \| `worker`"; "a runner registration created by the human operator" | Role names. |
| `delivery.md` | "Operator" in the *Written by* column; "a process an operator runs with its own producer credential" | "Human operator (`admin`)"; "a process the human operator runs with its own `producer` credential" | Names the credential each time. |
| `operator-automation.md` | "one implementation agent works under direct human supervision"; "Only a human administrator may opt in … the **Operator** expresses bounded intent"; "An `operator-agent` is not an administrator" | "one worker session works under the human operator's direct supervision"; "Only the human operator may opt in … the **operator agent** expresses bounded intent"; "An `operator-agent` is not the human operator and holds no `admin` authority" | The page used *Operator* for the agent and *administrator* for the human. |
| `master-agent.md` | "The master is a dedicated coordinator session … through the operator's own browser profile" | "The master is the coordinator: a `coordinator` principal run as the durable `master run` loop plus an optional visible master session … through the human operator's own browser profile" | The master is a loop and a session, not only a session. |
| `master-agent.md` | "Implementation agents running as the same OS user"; "Judgment calls stay with an agent or a human" | "Worker sessions running as the same OS user"; "Judgment calls stay with the visible master session or the human operator" | Which agent, which human. |
| `master-agent.md` | "stay with a person" | "stay with the human operator" | Canonical term. |
| `turnkey-delivery-roadmap.md` | "must not receive operator credentials"; "runs agents through their preferred runtime" | "must not receive the human operator's `admin` credential"; "runs agent sessions through their preferred runtime" | Canonical terms. |
| `test-cases.md` | "publication also requires an operator" | "publication also requires the human operator's `admin` credential" | Names the credential. |
| `github.md` | "Remove bypass privileges from implementation agents"; "before agent-driven PRs begin" | "from worker identities"; "before worker-authored PRs begin" | Role names. |
| `operations.md` | "An operator can clear an existing blocker"; "as an operator"; "an operator decision"; "Scoped post-bootstrap operator automation"; "A coordinator is read-only at the Graphyard API boundary"; "The UI keeps its token in session storage" | (now `operations-reference.md`) "The human operator can clear…"; "as the human operator"; "a human-operator decision"; "A scoped operator agent"; "The master's `coordinator` credential holds no lease, evidence, or requirement authority at the Graphyard API; beyond reads it may only acquire the bounded merge execution, settle a verified-dead containment quarantine, and record a deployment observation"; "The dashboard keeps its sign-in token in browser session storage" | Which operator; the coordinator sentence contradicted the protocol page; *session* in the browser sense. |

Pages read with no ambiguous instance found: `runner-setup.md` (every *operator* is the human operator approving digests and registrations), `visual-identity.md`, `delegation.md` (GY-31; already uses the canonical roles and `sessionKind` language), and the two `docs/history/` snapshots.

### Text merged from `main` after the first pass (GY-55 regression guard, GY-19 recovery)

The candidate was rebased on `main` after GY-55 (submit-time regression guard) and GY-19 (runner capacity, artifact backends, delivery rollback) merged. Their new pages and passages were audited the same way:

| Page | Before | After | Reason |
| --- | --- | --- | --- |
| `recovery.md` (new, GY-19) | "until … an operator settles with evidence"; "until an operator resolves it with evidence" | "until … the human operator settles it with evidence"; "until the human operator resolves it with evidence" | Which operator. |
| `recovery.md` | "(`POST /api/validation/artifacts/migrate`, operator only)"; "`rollback-resolve` (operator)" | "the human operator's `admin` credential only"; "(human operator, `admin`)" | Names the credential the server checks. |
| `recovery.md` | "An operator, or a promoter through its `delegate` lease, requests a rollback" | "The human operator (`admin`), or a promoter through its `delegate` lease, requests a rollback" | Which operator, which credential. |
| `delivery.md` (rollback row, GY-19) | "Operator or promoter; …; operator" in the *Written by* column | "Human operator (`admin`) or promoter; …; human operator (`admin`)" | Consistent with the rest of the table. |
| `coordination.md` (GY-55) | "A worker that merges the base branch … and a reviewer is a slow and unreliable way to notice." | "A worker session that merges the base branch … and an independent reviewer is a slow and unreliable way to notice." | Session vs role; the reviewer's independence is the point. |
| `coordination.md` | "The scope is the operator's."; "A master that returns a refused candidate for rework should quote…" | "The scope is the human operator's."; "A master that asks the human operator to return a refused candidate for rework (rework stays `admin` only) should quote…" | Which operator; the master holds no rework authority, so the original read as if it did. |
| `protocol.md` (GY-55) | "`plannedFiles` can be changed only by the operator `requirements` command." | "… only by the audited `requirements` command (the human operator's `admin` credential, or additively a scoped operator agent)." | Consistent with the `requirements` row of the commands table. |

Read with no ambiguous instance: the `sync` command text in `coordination.md` and `protocol.md` (*worker* names the role), the `scopeFiles` paragraph, `validation.md`'s capacity sentence, and the `rollback` registration sentence in `validation.md`. The safety statements these passages add — a worker cannot widen `plannedFiles`; a refused submission writes nothing; an `unknown` rollback outcome blocks successors until resolved with evidence — are preserved word for word apart from the role terms above. `recovery.md` was added to the in-app docs navigation.

## Concision samples (before / after)

| Page | Before | After |
| --- | --- | --- |
| `operations.md` (now the reference page) | 3,914 words in one page mixing daily checks, master-loop internals, ten recovery procedures, credentials, grants, drift, scale limits, and dashboard behaviour. | A 646-word primary page (excluding fenced code and the *Deeper references* list): daily checklist, incident decision tree, eight recovery recipes, bootstrap mode, the safety facts, and links. The full text lives unchanged in `operations-reference.md`. |
| `operations.md` › Lost worker | "The lease expires after 120 seconds without a heartbeat. Reconciliation clears the lease; a new worker can claim with a higher epoch. Old API mutations refuse. Preserve the old worktree for inspection and create a new branch/path for the new attempt. Do not assume the old process has stopped merely because its lease expired." (56 words) | "The lease expires 120 seconds after the last heartbeat; a new worker claims at a higher epoch and old-epoch commands refuse. Keep the old worktree; the new attempt gets a fresh branch. Expiry does not prove the old process stopped." (40 words) |
| `operations.md` › Merge bypass | "An observed merge with unsatisfied gates creates a permanent violation. Do not backfill evidence and pretend the merge was authorized. Inspect what bypassed protection, repair access rules, and create a follow-up investigation or repair task. v0.1 does not automatically revert code or deploy rollbacks." (44 words) | "An observed merge with unsatisfied gates is a permanent violation. Never backfill evidence. Repair the access rules and open a follow-up item." (22 words; the v0.1 rollback fact stays on the reference page) |
| `operations.md` › Master loop restart | "Stop and start it freely. The cursor beside the coordinator credential is written before and after every external action and is reconciled against Graphyard on the next start, so a restart never re-dispatches an assignment that landed and never loses one that did not. Do not edit or delete the cursor to force a retry; change the Graphyard state the loop is reading." (66 words) | "Restart `graphyard master run` freely; its cursor reconciles against Graphyard on start, so nothing is dispatched twice or lost. Never edit the cursor. A second loop refuses while the first is alive." (32 words) |
| `architecture.md` › Boundary | "Herdr owns agent sessions. Test runners produce evidence." plus a Mermaid graph that the in-app docs rendered as a code block. | "Herdr and other agent runtimes host agent sessions. Proof producers produce evidence." plus a rendered SVG with a legend and a text equivalent. |
| `onboarding.md` › lead paragraph | Mermaid graph with an unlabelled *Operator* box, then "You keep talking directly to the master. The master reads work and gate state from Graphyard, dispatches ready items to supervised workers, notices stalls, and performs routine exact-candidate merges when every configured gate passes. Workers write code in Graphyard-assigned worktrees. GitHub owns code review and CI facts; trusted runners produce acceptance evidence." | The rendered roles diagram, a text equivalent that names each role and credential, then "You keep talking directly to the master. GitHub owns code review and CI facts; proof producers produce acceptance evidence." |
| `master-agent.md` › Judgment calls | "Judgment calls stay with an agent or a human: reading a worker's report…" | "Judgment calls stay with the visible master session or the human operator: reading a worker's report…" |

## Safety-parity check

Each rewritten safety statement, side by side with its source. *Same or stronger* means the rewritten sentence forbids at least everything the original forbade and requires at least everything it required.

| Boundary | Before | After | Verdict |
| --- | --- | --- | --- |
| Lead restrictions | (`how-graphyard-works.md`, unchanged) "never implements, holds a worker lease, submits evidence, bypasses a gate, or merges" | Unchanged; the roles table in the glossary repeats it: "Implement, hold a lease, submit evidence, review its own slice, merge" under *Never*. | Same |
| Lead restrictions | `protocol.md` roles table had no `slice-lead` row. | "`slice-lead` \| Record rulings on work in its own slice and escalate; every lifecycle mutation from this role is refused and recorded" | Stronger (was unstated) |
| Gate requirements | `operations.md`: "What stays in force: independent review, every required CI check, the merge queue, and every proof of every criterion that is not marked. A bootstrap candidate with a failing check or no approval does not advance. Bootstrap mode buys sequencing, not a lower bar." | Primary page: "It needs `policy:bootstrap`, leaves every other gate in force, and becomes an obligation inherited by the next item touching those paths." Reference page: original text unchanged. | Same |
| Gate requirements | `how-graphyard-works.md`: "Requirements are never weakened just to make a candidate pass." | Unchanged; primary operations page adds "Never weaken requirements." | Same |
| Evidence trust | `architecture.md`: "A worker cannot self-assign trust. A producer credential has an allowlist of exact proof names. Operators may attest `manual:` proofs, but cannot use an operator token to mint trusted automated test evidence." | "A worker cannot self-assign trust. A producer credential has a live grant of exact proof names or bounded patterns. The human operator may attest `manual:` proofs, but cannot use an `admin` token to mint trusted automated test evidence." | Same (and now matches the shipped grant model) |
| Evidence trust | `quickstart.md`: "A trusted producer—not the implementation worker—submits required evidence." | "A proof producer—never the worker—submits the required evidence." | Stronger modal |
| Evidence trust | `how-graphyard-works.md`: "Authorized proof producers report the required behavioral evidence." | "Proof producers with a live grant report the required behavioral evidence." | Same (authority named precisely) |
| Merge authority | `operations.md`: "A direct GitHub merge has no verified execution and cannot complete its Graphyard work item." | Primary page: "a direct GitHub merge has no verified execution and cannot complete its item." Reference page: unchanged. | Same |
| Merge authority | `operations.md`: "Do not backfill evidence and pretend the merge was authorized." | "Never backfill evidence." | Stronger modal |
| Merge authority | `operations.md` › master loop: "Do not edit or delete the cursor to force a retry" | "Never edit the cursor." | Stronger modal |
| Merge authority | `deployment.md`: coordinator "can read control-plane state but cannot claim work, revise requirements, or submit evidence" | "can read control-plane state and request the guarded merge but cannot claim work, revise requirements, or submit evidence" | Same restrictions; the one permitted write is now stated |
| Merge authority | `operations.md` › credentials: "A coordinator is read-only at the Graphyard API boundary" | "The master's `coordinator` credential holds no lease, evidence, or requirement authority at the Graphyard API; beyond reads it may only acquire the bounded merge execution, settle a verified-dead containment quarantine, and record a deployment observation." | Same restrictions, now consistent with `protocol.md` |
| Human-only authorities | `master-agent.md`: "…approving a merge when automatic merging is disabled stay with a person." | "…stay with the human operator." | Same |
| Human-only authorities | `operations.md`: "Resolution requires a credential declaring `sessionKind: "human"`, so no AI principal — lead, worker, producer, scoped operator agent, or an `admin` credential that declares `ai` or declares nothing — can resolve one." | Primary page: "a declared human session runs `graphyard resolve …`. No AI principal can." Reference page: unchanged. | Same |
| Human-only authorities | `onboarding.md`: "a human administrator may optionally configure scoped operator automation" | "the human operator may optionally configure scoped operator automation" | Same |
| Worker credentials | `onboarding.md`: "Never give an implementation worker an admin, coordinator, or producer token." | "Never give a worker an `admin`, `coordinator`, or `producer` token." | Same |
| Worker credentials | `coordination.md`: "Keep operator and producer credentials off both worker environments." | "Keep `admin` and `producer` credentials off both worker environments." | Same (credential named) |
| Requirement revision | `coordination.md`: "Only an operator may revise requirements; implementation workers cannot weaken their own gates." | "Only the human operator's `admin` credential may revise requirements this way (a scoped operator agent may only add); workers cannot weaken their own gates." | Same for workers; operator-agent limit now stated |
| Requirement revision | `protocol.md`: "`requirements` … operator only" | "`admin`, or an operator agent holding `policy:requirements` (additive only)" | Corrected to the enforced rule; no authority added |

No safety statement was removed. The full `operations.md` text, including every sentence not quoted above, is preserved verbatim or with the terminology edits listed in the ambiguity table on `operations-reference.md`.

## GY-28 and GY-31 integration

- GY-28's delivered text in `how-graphyard-works.md` — the two-phase handoff, the four-session table, and the separation paragraph — is unchanged; every sentence that `browser-tests/dashboard.spec.ts` asserts still appears verbatim. This audit added the two diagrams *after* those blocks and pointed the page at the glossary.
- GY-31's `delegation.md` is unchanged. The glossary's slice-lead row, the `slice-lead` row added to the protocol roles table, and the *slice lead* box in the roles diagram restate its authority boundary without altering it.
- This item held the `docs-role-glossary` exclusive resource for the duration of the rewrite; no other item edited the glossary concurrently.

## Diagrams

Three SVGs under `docs/diagrams/`, generated by `scripts/render-docs-diagrams.mjs` and committed:

| File | Used by | Legend | Text equivalent |
| --- | --- | --- | --- |
| `roles-and-authority.svg` | `how-graphyard-works.md`, `onboarding.md` | Drawn inside the image; keyed to the glossary | Adjacent paragraph on each page; `alt`, `<title>`, and `<desc>` in the file |
| `bootstrap-vs-normal.svg` | `how-graphyard-works.md` | Same | Same |
| `control-plane-components.svg` | `architecture.md` | Same | Same |

Each SVG paints its own opaque surface, so it renders identically on GitHub light and dark themes and on the dark in-app page. Text/background pairs (WCAG relative luminance): `#e6ede4` on `#111714` (15.2:1), `#f6e7b8` on `#3a3020` (10.5:1), `#e1f3c8` on `#22311f` (11.7:1), `#d8ecf9` on `#182a36` (12.1:1), `#e9e0f9` on `#2a2338` (11.8:1), `#e3e9e3` on `#262d28` (11.4:1), arrow labels `#b8c6b7` on `#111714` (10.2:1), chip text `#c5e69b` on `#111714` (13.1:1); box outlines against their fills are at least 7.5:1. The in-app renderer maps the Markdown image path to the Vite-emitted asset; GitHub renders the same relative path. The former Mermaid blocks, which the in-app docs showed as code, were replaced.

## Verification run

- `npm run docs:check` — relative links, anchors, and diagram files resolve.
- `npm run build` — typecheck and Vite build with the docs and diagrams included.
- `npm test` — includes `tests/docs-glossary.test.ts`, which checks the glossary's eight sections, the operations page word budget, the SVG accessibility attributes, and that every diagram image has non-empty alt text and an adjacent text equivalent.
- `npm run test:browser` — the docs pages (`how-graphyard-works`, `glossary`, `operations`, `architecture`) at 1280×900 and 390×844: diagrams load with a natural width, legend text is visible, no page scrolls horizontally, and the operations checklist and decision tree render.
