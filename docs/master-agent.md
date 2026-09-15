# Master-agent operating mode

Graphyard recommends one dedicated master agent when a repository has several coding agents. The master watches the engineering system, routes ready work, notices stalls, requests recovery, and performs routine merges after Graphyard authorizes the exact candidate. It does not write product code.

This is an operating pattern, not a new source of truth. Graphyard owns work, dependencies, leases, evidence, and progression. Git owns code. GitHub owns pull-request and merge facts. Herdr owns visible sessions. The master joins these views and acts on them; it never keeps a parallel assignment ledger.

## The first-run experience

The control-plane operator first creates a distinct `coordinator` principal in the server's private `GRAPHYARD_PRINCIPALS` value. A coordinator can read the authenticated control-plane APIs and acquire or cancel the engine's bounded merge execution authority. It cannot claim work, revise requirements, submit evidence, or exercise other operator powers.

From the repository to be managed:

```sh
node /absolute/path/to/graphyard/bin/graphyard.mjs master init \
  --url https://YOUR-GRAPHYARD-HOST \
  --token-stdin
```

Paste or pipe the coordinator token, then EOF. Setup verifies the token and GitHub repository before writing anything. It:

- discovers the repository and proposed checks;
- preserves existing `AGENTS.md` content and installs managed worker and master sections;
- writes non-secret repository routing settings to ignored `.graphyard/master.json` and the coordinator token to a mode-0600 file under the operator's Graphyard configuration directory, outside the managed repository;
- enables exact-candidate routine merging by default;
- prints the next setup action without printing a credential.

Commit the managed `AGENTS.md` update. Never commit `.graphyard/`. Rerun setup after moving the Graphyard CLI. Use `--host-id` to set the stable identity of this worker machine, `--no-auto-merge` for teams that want every otherwise-routine merge to remain manual, or `--merge-method squash|rebase` to change the normal merge method.

Launch the dedicated visible coordinator after setup:

```sh
graphyard master start codex
# or: graphyard master start claude
```

This creates a non-focused Herdr tab, starts the selected agent, and prompts it to read the managed instructions, print the packaged guide, and inspect live status. Provider-specific arguments may follow `--`. Setup and start do not create worker assignments.

## Add workers

Each concurrent worker needs its own Graphyard `worker` principal. Agent-provider login and Graphyard identity are separate concerns.

An already-running, already-authenticated Herdr agent can be registered for health and assignment observation without storing its credential in the master configuration:

```json
{
  "name": "codex-existing",
  "principal": "worker-codex-1",
  "agentName": "eng-codex-1",
  "mode": "existing"
}
```

A master can also launch a visible agent. Put that worker's Graphyard token alone in a local mode-0600 file outside every linked worktree of the managed repository, then reference the path:

```json
{
  "name": "claude-primary",
  "principal": "worker-claude-1",
  "agentName": "eng-claude-1",
  "mode": "launch",
  "kind": "claude",
  "credentialFile": "/home/operator/.config/graphyard/workers/claude-1.token",
  "agentArgs": [],
  "environment": {
    "CLAUDE_CONFIG_DIR": "/home/operator/.config/claude-primary"
  }
}
```

Add either profile with:

```sh
graphyard master worker add /path/to/profile.json
```

For launch profiles, Graphyard verifies the credential is a worker token for the stated principal. The explicit `GRAPHYARD_TOKEN_FILE` supplied to that session takes precedence over ambient `GRAPHYARD_TOKEN` values and repository `.env` files, preventing a coordinator or operator shell identity from leaking into worker actions. Provider/account routing uses the agent kind, arguments, and non-secret profile locators in `environment`. Keys that look like passwords, tokens, private keys, or API credentials are rejected. Authenticate Codex, Claude, or another runtime locally using its normal login flow; do not copy provider secrets into the profile.

Existing profiles are suitable for joining Herdr health to work the session already owns. Graphyard deliberately refuses to dispatch new work into an existing interactive process because it cannot retroactively make that process a child of the lease supervisor. Use a launch profile for new assignments. The worker launch wrapper's Graphyard claim is the authoritative identity check.

## Operating loop

Run this when the master starts, after dispatch, when a worker reports completion, and whenever an integration event arrives:

```sh
graphyard master status
```

Every master command revalidates the configured coordinator role, repository, managed base branch, and GitHub App identity against the live control plane. If the binding changes, it refuses and asks the operator to rerun `master init` before any routing or merge action. Master commands resolve only the dedicated coordinator configuration and credential; malformed or unavailable worker connection state and unrelated worker token files in the surrounding shell cannot disable them.

The report reads one Graphyard work snapshot and joins configured Herdr sessions by agent name. Its owners, stages, refusals, and merge candidates come only from Graphyard. A missing or stopped session is attention, not proof that an assignment disappeared. A visible session is health information, not proof that it owns work.

For a ready item:

```sh
graphyard master dispatch GY-42 claude-primary
```

Dispatch uses the same claimability rules as the control plane: the work must be released, unblocked, dependency-safe, resource-safe, and unowned, with no prior submission unless an operator explicitly requested rework. This permits the documented recovery handoff even though preserved submission history keeps its display stage at Build. Dispatch refuses existing-session profiles. For new work, a launch profile's worker-scoped launcher fetches and resolves the current managed base branch, claims immediately before launch, and creates the assigned worktree from that exact base. For rework, it instead fetches the preserved PR branch, verifies its head against Graphyard's observation, detaches any stopped local checkout that still holds the branch so its historical HEAD and files remain stable, and opens a fresh checkout of that branch. It then creates a non-focused visible tab and runs the coding agent as a child of `graphyard watch`. The supervisor renews the lease and terminates the complete child process group on lease loss. Only after Herdr detects the supervised agent does the master name and prompt it. If tab creation, detection, naming, or prompt delivery fails, dispatch closes the pane, confirms it is absent from Herdr, and releases that exact lease epoch. If shutdown cannot be confirmed, the lease remains held so another worker cannot overlap the possibly live process. Prompt delivery itself never becomes ownership.

An operator may set `GRAPHYARD_REQUEST_ID` to retry the outer dispatch command. The launcher removes that key from the worker environment so claim, workspace registration, heartbeat, submission, and cleanup remain separate idempotent mutations.

The master then watches for:

- ready work with no suitable idle worker;
- active leases whose configured session is offline or blocked;
- context pressure that needs a deliberate handoff;
- gate refusals with a concrete next action;
- submitted work that needs an operator-authorized rework;
- merge-authorized candidates.

If Herdr is unavailable, `master status` still returns the Graphyard work snapshot and marks Herdr health unavailable. Runtime telemetry may disappear; ownership, gate, and progression truth do not.
If one launch profile's credential is missing, insecure, or temporarily unmounted, status marks that worker credential unavailable without disabling coordinator status or routine merges. Dispatch validates the selected worker immediately before claiming work.

The master does not clear blockers or revise intent on its own. It asks the operator for a narrow decision when requirements, human acceptance, destructive operations, or policy changes are involved.

## Routine merges

```sh
graphyard master merge GY-42
graphyard master merge --all
```

`--all` processes only candidates with a current all-gates-passing authorization. It records a per-item refusal and continues if a selected candidate changes during its final checks. A stale, changed, or refusing item remains visible in status but does not prevent another authorized item from merging.

For every candidate, the command requires:

1. stage `merge` and every Graphyard gate passing;
2. no recorded violation;
3. a merge authorization matching head SHA, base SHA, and policy revision;
4. a fresh Graphyard observation, evaluated against the database time in the snapshot;
5. a GitHub read that sees the same head, base commit, and managed base-branch name on an open, non-draft PR;
6. a second Graphyard snapshot with the same work revision, fresh observation, and authorization;
7. a server-issued, coordinator-owned, single-use merge execution that freezes gate-affecting work, evidence, validation, and observation mutations for the bounded merge attempt, while allowing the assigned worker's existing lease supervisor to keep heartbeating, expires no later than its required evidence or observation, and refuses inputs without enough remaining lifetime for the provider timeout;
8. a second GitHub read after authority acquisition with the same head, base commit, and managed base-branch name;
9. a fresh branch-protection read that still requires strict checks, enforced administration, the Graphyard App's own merge check, no force pushes or deletion, and the configured native review rules when applicable;
10. a Graphyard App observation that re-reads and re-evaluates every mutable GitHub gate, including configured CI producer results, review state, Codex review evidence, mergeability, and branch protection, against the active execution without advancing lifecycle state;
11. a second execution-lifetime check after final GitHub verification, immediately before provider invocation;
12. GitHub's merge API with the authorized head SHA and normal branch protection. Queue enrollment is treated as a refusal because it cannot complete inside the bounded authority window.

It never uses `--admin`. A human approval represented as required evidence remains a refusing gate until supplied. If GitHub explicitly reports that it did not merge, the master cancels the execution authority; that cancelled attempt cannot authorize a later merge, and retrying requires a new execution. A timeout, lost response, or malformed response has an unknown provider outcome, so the authority stays active until Graphyard observes the matching merge or the bounded execution expires. Replaying an acquisition request can return the same authority after a harmless worker heartbeat, but only while that exact execution is still active and all bound gate inputs remain current. After the merge command succeeds, the item is still not declared Done by the master; Graphyard keeps the authority active until it observes a matching merge whose provider timestamp proves it occurred after the grant and before the execution and required evidence expired. An earlier, late, cancelled, or ambiguously ordered merge remains a visible violation.

Only the coordinator that acquired an execution may cancel it. Periodic GitHub reconciliation defers without publishing a failing required check while that execution is active, including a reconciliation read that began before acquisition and became stale during its provider call. A webhook generation change still wakes reconciliation immediately so an observed matching merge can complete the item. Cancelling an execution also wakes the durable job immediately instead of waiting for the cancelled deadline.

The present command uses the local authenticated GitHub CLI for the final provider action. Graphyard's transactional execution authority closes the control-plane mutation race around that external call without holding a database transaction open during network I/O.

## Handoffs and recovery

Provider changes, account quota changes, machine changes, and context-window replacement all use the same recovery model:

1. stop the previous worker and its supervisor;
2. let the lease expire or release it explicitly;
3. have an operator request rework when implementation was already submitted;
4. dispatch a different profile;
5. let that worker claim a higher epoch and register a fresh workspace;
6. preserve the earlier worktree and events for audit.

The master may summarize a handoff in the work item or PR, but Graphyard state and Git history remain the proof. Never share one worker token across concurrent sessions. On multiple machines, use distinct principals and stable host IDs, and keep credential files local to the machine that launches that worker.

The coordinator token has only read and bounded merge-execution authority and is stored outside the repository. File modes do not isolate processes running as the same OS user. Run the master under a separate OS account or on a dedicated coordination machine when implementation agents are not trusted with same-user filesystem visibility. Graphyard's gates and GitHub protection remain the merge authority even for trusted same-machine workers; the master token cannot claim work, revise requirements, or submit evidence.

## Recommended boundaries

Use the master for observation, capacity routing, stall detection, handoffs, and routine exact-candidate merges. Keep these authorities separate:

| Identity | Allowed responsibility |
| --- | --- |
| `coordinator` | Read work truth, route Herdr sessions, acquire/cancel bounded merge execution, invoke the exact-head provider call |
| `worker` | Claim, heartbeat, register its workspace, implement, block, submit assertions |
| `producer` | Submit only its configured trusted proofs |
| `admin` | Define/revise intent, release work, authorize rework, supply manual evidence |
| `reader` | Inspect state |

For a single task or initial bootstrap, one supervised worker remains supported. Add a dedicated master when concurrency makes work discovery, recovery, and merge follow-through a recurring responsibility.
