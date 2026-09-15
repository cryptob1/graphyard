# Master-agent operating mode

Graphyard recommends one dedicated master agent when a repository has several coding agents. The master watches the engineering system, routes ready work, notices stalls, requests recovery, and performs routine merges after Graphyard authorizes the exact candidate. It does not write product code.

This is an operating pattern, not a new source of truth. Graphyard owns work, dependencies, leases, evidence, and progression. Git owns code. GitHub owns pull-request and merge facts. Herdr owns visible sessions. The master joins these views and acts on them; it never keeps a parallel assignment ledger.

## The first-run experience

The control-plane operator first creates a distinct `coordinator` principal in the server's private `GRAPHYARD_PRINCIPALS` value. A coordinator can read the authenticated control-plane APIs. It cannot claim work, revise requirements, submit evidence, or exercise operator powers.

From the repository to be managed:

```sh
node /absolute/path/to/graphyard/bin/graphyard.mjs master init \
  --url https://YOUR-GRAPHYARD-HOST \
  --token-stdin
```

Paste or pipe the coordinator token, then EOF. Setup verifies the token and GitHub repository before writing anything. It:

- discovers the repository and proposed checks;
- preserves existing `AGENTS.md` content and installs managed worker and master sections;
- writes `.graphyard/master.json` with mode 0600 inside the Git-ignored local directory;
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

An already-running, already-authenticated Herdr agent can be adopted without storing its credential in the master configuration:

```json
{
  "name": "codex-existing",
  "principal": "worker-codex-1",
  "agentName": "eng-codex-1",
  "mode": "existing"
}
```

A master can also launch a visible agent. Put that worker's Graphyard token alone in a local mode-0600 file, then reference the path:

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

Existing profiles are suitable when Herdr or another operator already launched the session with the correct identity. The worker's subsequent Graphyard claim is the authoritative identity check.

## Operating loop

Run this when the master starts, after dispatch, when a worker reports completion, and whenever an integration event arrives:

```sh
graphyard master status
```

The report reads one Graphyard work snapshot and joins configured Herdr sessions by agent name. Its owners, stages, refusals, and merge candidates come only from Graphyard. A missing or stopped session is attention, not proof that an assignment disappeared. A visible session is health information, not proof that it owns work.

For a ready item:

```sh
graphyard master dispatch GY-42 codex-existing
```

Dispatch refuses an assigned or non-ready item. It prompts an existing idle Herdr agent or creates a non-focused visible tab for a launch profile. The prompt requires the worker to claim under its own credential, use Graphyard's worktree, supervise its lease, and submit rather than merge. The response says `ownership: pending worker claim`; prompt delivery never becomes ownership.

The master then watches for:

- ready work with no suitable idle worker;
- active leases whose configured session is offline or blocked;
- context pressure that needs a deliberate handoff;
- gate refusals with a concrete next action;
- submitted work that needs an operator-authorized rework;
- merge-authorized candidates.

The master does not clear blockers or revise intent on its own. It asks the operator for a narrow decision when requirements, human acceptance, destructive operations, or policy changes are involved.

## Routine merges

```sh
graphyard master merge GY-42
graphyard master merge --all
```

For every candidate, the command requires:

1. stage `merge` and every Graphyard gate passing;
2. no recorded violation;
3. a merge authorization matching head SHA, base SHA, and policy revision;
4. a fresh GitHub read that sees the same head and base on an open, non-draft PR;
5. a second Graphyard snapshot with the same work revision and authorization;
6. GitHub's `--match-head-commit` guard and normal branch protection.

It never uses `--admin`. A human approval represented as required evidence remains a refusing gate until supplied. After the merge command succeeds, the item is still not declared Done by the master; Graphyard waits to observe and reconcile the actual merge.

The present command uses the local authenticated GitHub CLI. A future server-side merge broker can move the final action behind a single-use authorization, but the current double-read and exact-head checks provide a safe supervised path without weakening GitHub protection.

## Handoffs and recovery

Provider changes, account quota changes, machine changes, and context-window replacement all use the same recovery model:

1. stop the previous worker and its supervisor;
2. let the lease expire or release it explicitly;
3. have an operator request rework when implementation was already submitted;
4. dispatch a different profile;
5. let that worker claim a higher epoch and register a fresh workspace;
6. preserve the earlier worktree and events for audit.

The master may summarize a handoff in the work item or PR, but Graphyard state and Git history remain the proof. Never share one worker token across concurrent sessions. On multiple machines, use distinct principals and stable host IDs, and keep credential files local to the machine that launches that worker.

## Recommended boundaries

Use the master for observation, capacity routing, stall detection, handoffs, and routine exact-candidate merges. Keep these authorities separate:

| Identity | Allowed responsibility |
| --- | --- |
| `coordinator` | Read work truth, route Herdr sessions, invoke guarded local merge flow |
| `worker` | Claim, heartbeat, register its workspace, implement, block, submit assertions |
| `producer` | Submit only its configured trusted proofs |
| `admin` | Define/revise intent, release work, authorize rework, supply manual evidence |
| `reader` | Inspect state |

For a single task or initial bootstrap, one supervised worker remains supported. Add a dedicated master when concurrency makes work discovery, recovery, and merge follow-through a recurring responsibility.
