# Herdr integration

Herdr is Graphyard's first launch integration. The root `herdr-plugin.toml` follows the installed Herdr plugin format and declares a ledger pane and an action to open it. The adapter uses the public HTTP API; Graphyard does not depend on Herdr internals to enforce ownership.

## Install

Requires Node 24 and Herdr with native plugin support (manifest minimum 0.7.1). From the repository you want to manage, invoke a local Graphyard checkout:

```sh
node /absolute/path/to/graphyard/bin/graphyard.mjs init --url https://YOUR-GRAPHYARD-HOST --herdr --token-stdin
```

Supply an individual worker token on standard input, then EOF (Ctrl-D). A password manager can pipe it in; do not put it in command arguments or shell history. `GRAPHYARD_TOKEN` is also supported. The npm package has not been published.

Setup authenticates the credential and requires the worker role. It saves the connection in ignored `.graphyard/connection.json` with mode 0600, updates one managed section in `AGENTS.md` while preserving your surrounding instructions, links the Herdr plugin disabled, saves its private configuration, and enables it last. Output contains connection metadata, never the token. Commit the updated `AGENTS.md`, not the local connection file.

Rerunning updates the managed section without duplicating it. Malformed markers and non-regular setup files are refused. A failed Herdr command can leave repository setup saved; fix the installation and rerun. Keep the Graphyard checkout at its configured absolute path, or rerun with the new launcher path. Linked worktrees inherit the main checkout's connection without copying credentials.

Without `--herdr`, setup only configures repository instructions and the CLI connection. Without a token, it saves an unverified connection and tells you to finish authentication. An explicit server change does not forward a saved token; supply the new server's credential explicitly.

For a read-only plugin, manually link it and configure a reader credential. Automated worker setup deliberately rejects reader, operator, and producer tokens. Never configure privileged credentials in an implementation agent's environment.

## Use

Invoke **Open Graphyard control plane** from Herdr's plugin actions. The ledger pane supports:

```text
list
show GY-1
claim GY-1
handoff GY-1
heartbeat GY-1 1
release GY-1 1
quit
```

The pane displays each task's current stage, owner, and first refusal. Claiming work does not launch another agent, acknowledge a prompt, or start a background heartbeat. It returns the assignment epoch and next commands. The lease expires after two minutes unless a worker acknowledges ownership through renewal.

After claiming, run `handoff GY-1` in the pane. It checks your live lease and machine identity, then prints worktree setup commands or the assigned workspace and supervisor command. It refuses expired ownership and workspaces on another host. Follow those commands to launch your desired agent:

```sh
graphyard watch GY-1 1 -- YOUR_AGENT_COMMAND
```

Here `graphyard` means the locally installed bin or `node /path/to/graphyard/bin/graphyard.mjs`; the npm package has not been published. If Herdr owns process launch, it can instead call the HTTP heartbeat endpoint and stop the agent when renewal fails. Do not heartbeat merely because prompt delivery succeeded: renew only for an acknowledged live worker.

## Many machines

Every machine points to the same Graphyard URL and receives individual worker credentials. Use stable, unique host IDs for worktree registration: pass `--host-id YOUR_MACHINE_ID` to init (default: hostname). Each independently running worker needs its own identity; do not share one worker token across concurrent sessions. The local plugin configuration currently selects one server and worker identity at a time. Herdr's remote session transport is independent of Graphyard's network protocol.

The Graphyard server never needs SSH access or local paths mounted from worker machines. Worktree actions execute where Herdr or the agent runs. The server validates reservations and provider-observed PR branches.

## First fleet test

After the MVP is deployed and GitHub protection is active:

1. Create two independent work items and one dependent item.
2. Launch workers on two hosts in distinct worktrees with distinct credentials.
3. Race both workers for one item and confirm exactly one gets a lease.
4. Stop a worker before submission, wait for expiry, and reclaim from the other host.
5. Attempt a heartbeat and submission with the old epoch; both must refuse.
6. Submit a PR, attach stale evidence, and confirm merging remains blocked.
7. Produce current trusted evidence and review; verify the required check passes.
8. Merge and observe completion, then confirm the dependency becomes claimable.

Record actual evidence in Graphyard. The automated local race tests are useful kernel validation; they are not a substitute for this Herdr/multi-host acceptance test.

## Next plugin work

Automated dispatch/ACK handling, agent-specific lifecycle hooks, and rich Herdr pane rendering are intentionally deferred until this basic protocol is exercised with real sessions. No multiple-agent session is launched during the initial single-agent build.

Host IDs from setup and `GRAPHYARD_HOST_ID` have surrounding whitespace removed before workspace registration and handoff checks. Empty host IDs are rejected. Use a stable, distinct ID for each machine.

When a server declares its GitHub repository, setup verifies that the checkout's `origin` identifies the same repository (case-insensitively) before saving credentials or enabling the plugin. A missing/unrecognized origin or a different repository refuses setup. Configure the correct GitHub origin first. Servers without a configured repository can still support local bootstrap discovery.

An explicit `GRAPHYARD_HOST_ID` takes precedence over the host ID saved by setup in both the CLI and Herdr handoff. Invalid explicit values are passed through to the CLI's validation rather than silently replaced by a saved host.
## Agent names and automatic board assignment

Each independently running worker must have its own Graphyard principal and token. The operator can optionally add `displayName` and `runtime` to that principal in the server's private `GRAPHYARD_PRINCIPALS` configuration. For example, a worker with ID `worker-17`, display name `Atlas`, and runtime `Codex` appears as **Atlas · Codex** when it claims a task. Runtime is a display label and can describe Claude, Codex, a custom tool, or a human-assisted worker; it does not change authorization.

Assignment happens atomically when the authenticated worker successfully claims the task. The work board and Herdr ledger derive ownership from that lease, not from a typed name, a prompt delivery, or a PR author's GitHub account. Claim requests cannot supply another owner's identity. Agent names and runtimes are operator-configured metadata; Graphyard does not infer them from running processes or verify the model a worker actually uses.

The display identity is snapshotted with each claim and preserved in event history. After release or expiry, the card says **Last worked by Atlas · Codex**, while details say there is no active assignment. Reclaiming under another worker updates the current label and preserves the earlier claim in history. An unconfigured worker displays its canonical ID, and older work items use their recorded workspace owner when available. Renaming a configured worker affects future claims; it does not rewrite historical identity.

Configure one identity per concurrent worker, even when several workers use the same coding tool. A shared `herdr-worker-1` token cannot identify which of several sessions is acting. Keep the stable canonical worker ID visible in task details when names are similar. Server configuration changes require a restart; follow your deployment review process and never commit the principal tokens.

Assignment activity in the dashboard and Herdr ledger is evaluated at the control plane’s work-snapshot Postgres time, matching the clock used to enforce leases. A worker machine’s clock cannot expire or revive a lease in the display. Refresh to obtain a newer observation; the server remains authoritative for all commands.

During upgrades, existing leases retain their owner and epoch before expiry or release clears the lease. Older assignments without recorded labels or claim times keep those fields unknown; Graphyard does not invent identity metadata.

The dashboard and Herdr list use `/api/work-snapshot`, which returns work and its database observation time in one SQL snapshot. They do not pair a work response with a separately fetched status clock. Upgrade the server before using this adapter version.

CLI `next` and `handoff` also use the timestamp paired with `/api/work-snapshot`. Host clock skew or a later status response cannot make an active assignment appear expired. Handoff still checks the authenticated worker identity; the supervisor verifies the current lease before launching the child.

Long agent names and runtimes are truncated on work cards. Hover the label to see the full identity and worker ID, or open the work details for the full, wrapped assignment.

Setup checks Git’s effective ignore rules before saving local credentials. If later negations re-include `.graphyard`, it appends a final directory exclusion and verifies it; an unverifiable or still-unignored credential path refuses setup.

When init runs in a linked worktree, it saves the shared worker connection in the primary checkout’s ignored `.graphyard/connection.json`; managed instructions and discovery stay in the checkout where init ran. Sibling worktrees read the shared connection first, with a legacy worktree-local connection used only when no shared file exists. Individual workers can override that machine default through their environment. Bare repositories without a primary checkout are not supported by this setup path. Explicit `--token-stdin` input must be nonempty; an empty or whitespace-only stream refuses before saving configuration.

Repository discovery recognizes GitHub HTTPS, `git@github.com:owner/repo.git`, and URI-style SSH origins, including `ssh://git@github.com/owner/repo.git` and `ssh://git@ssh.github.com:443/owner/repo.git`. Other hosts are not treated as GitHub.

An explicitly empty or whitespace-only `GRAPHYARD_TOKEN` also refuses init instead of clearing saved credentials. A nonempty `--token-stdin` value takes precedence over that environment setting.
