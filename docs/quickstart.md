# Quickstart

For the complete recommended setup of a new GitHub repository—including Railway, GitHub enforcement, Herdr, the dedicated master, and worker profiles—start with [Repository onboarding](onboarding.md).

For repository discovery, guided GitHub registration, and the first independently proven PR, follow [First enforced PR](first-pr.md).

This guide starts one control plane and registers a worker. Run one shared server for all machines; do not give every machine a separate ledger.

## 1. Start the server

Install Node 24 and Docker. Clone the repository, then:

```sh
npm ci
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Generate a distinct secret for each principal and replace the example tokens in `.env`. The server rejects tokens shorter than 32 characters and duplicate IDs/tokens. Keep operator, coordinator, and worker credentials separate. Give a trusted runner only the proof names it may attest.

```sh
docker compose up -d db
npm run build
npm start
```

`npm start` loads `.env`. Open `http://localhost:4310`. Use the operator token to create work; the UI stores the token in browser session storage and removes it on sign-out.

For live frontend development, run `npm run dev` and `npm run dev:web` in separate terminals. The Vite server proxies `/api` to port 4310.

## 2. Define intent and proof

Create work in the UI or use [examples/work.json](../examples/work.json). A criterion lists one or more proof names. **All** listed proofs are required. A proof name has a type prefix: `unit:`, `integration:`, `e2e:`, or `manual:`.

```sh
export GRAPHYARD_URL=http://localhost:4310
export GRAPHYARD_TOKEN=YOUR_OPERATOR_TOKEN
npm run cli -- create examples/work.json
npm run cli -- ready GY-1
```

Use the returned key if this is not your first item. Requirements are immutable in v0.1 so a worker cannot weaken its own acceptance criteria. Dependencies must refer to existing work UUIDs, not display keys. Only delivered dependencies permit a claim.

## 3. Claim from a worker machine

On the machine that will execute the agent, use an individual worker token:

```sh
export GRAPHYARD_URL=https://YOUR-GRAPHYARD-HOST
export GRAPHYARD_TOKEN=YOUR_WORKER_TOKEN
node /path/to/graphyard/bin/graphyard.mjs next
node /path/to/graphyard/bin/graphyard.mjs claim GY-1
```

The response includes `lease.epoch` and `lease.expiresAt`. Claim acquisition itself is the worker acknowledgment. There is no agent launch implied by claiming.

From your managed repository checkout:

```sh
node /path/to/graphyard/bin/graphyard.mjs init
node /path/to/graphyard/bin/graphyard.mjs worktree GY-1 1 origin/main
cd .graphyard/worktrees/GY-1-1
node /path/to/graphyard/bin/graphyard.mjs watch GY-1 1 -- YOUR_AGENT_COMMAND
```

Substitute the actual epoch. `watch` renews the lease every 25 seconds and terminates the process group if renewal fails. Foreground Herdr workers on Linux run in a unique systemd user scope, which keeps descendants contained across forks and reparenting until the grace-period kill completes; a working systemd user manager is therefore required for that launch mode. Before launch, `watch` records an epoch-bound containment quarantine. It keeps a random settlement capability only in the parent supervisor, retries ambiguous establishment and post-shutdown settlement responses with a stable per-operation request key and exact body, and requires Graphyard to confirm the exact epoch, capability hash, and resource fence. Immediately before spawn it reads fresh control-plane state and rechecks the authenticated owner, live lease, quarantine, exact workspace, and exclusive resources; an old idempotency receipt can never authorize launch after rework, expiry, or reassignment. If bounded establishment retries cannot confirm the result, it abandons launch; bounded settlement ambiguity fails closed after the one child execution and retains the quarantine for stopped-worker recovery. Requirements and their exclusive-resource reservations cannot change while the quarantine remains. After SIGKILL the supervisor boundedly polls the scope and clears the fence only after systemd reports the scope inactive or failed, or specifically confirms that the transient unit is unloaded with `LoadState=not-found`, so lease expiry cannot make a possibly live assignment claimable. Manager connection and other query failures remain unverifiable and fail closed. Capability settlement is still accepted if independently observed delivery reaches Done during this shutdown race; all other delivered mutations remain forbidden. The random capability stays in the parent and is never copied to the child environment or durable history. A shutdown-verification timeout or unavailable systemd manager makes supervision fail closed; after independently confirming termination, an operator can use the existing rework command and its `--previous-worker-stopped` attestation to clear the quarantine. Foreground Herdr launch is refused on macOS because Graphyard does not yet provide equivalent durable containment there. Linux fallback cleanup revalidates cached parents and targets processes by kernel start-time ticks from `/proc/<pid>/stat`, avoiding PID reuse collisions during descendant traversal and signaling; platforms without an equivalent identity do not use that fallback. Do not keep another unsupervised worker running on the same assignment. On Windows, process-group supervision is not supported as strongly as on Linux.

If Herdr creates the worktree, [register it instead](protocol.md#workspaces). The registry cannot remotely inspect the filesystem; it records the worker's claim about location, and independently verifies the PR branch later.

## 4. Submit the implementation

Push the assigned branch and open a PR to the configured base branch. While the lease is active:

```sh
node /path/to/graphyard/bin/graphyard.mjs complete GY-1 1 123
```

`123` is the PR number. `complete` submits implementation, not lifecycle completion. Graphyard reads the PR independently, requires the assigned branch, and evaluates review, CI, acceptance, and merge gates.

Configure the [GitHub App and protection](github.md) before this step for a full lifecycle. Without that integration, Graphyard can coordinate claims but cannot authorize merges.

## 5. Attach acceptance evidence

A trusted runner submits evidence using its own narrowly scoped producer token. Replace all placeholder fields in [examples/evidence.json](../examples/evidence.json) with the actual candidate and independently observed result.

```sh
node /path/to/graphyard/bin/graphyard.mjs evidence GY-1 evidence.json
```

Worker-submitted evidence remains an assertion. Naming a runner or setting a pass result does not make it trusted. All required proofs need current matching evidence, a passing result, at least one executed assertion, and zero skipped tests.

## 6. Merge through the guarded path

Install the [recommended master-agent operating mode](master-agent.md), even for the initial single supervised worker. After every gate passes, run:

```sh
node /path/to/graphyard/bin/graphyard.mjs master merge GY-1
```

The command acquires bounded authority, verifies the exact current GitHub candidate and gates, and invokes the protected merge. Graphyard marks the item Done only after independently observing that verified merge. A direct GitHub merge has no verified execution and becomes a visible unauthorized-merge violation. No deployment guarantee is implied in v0.1.

As the worker fleet grows, the same master setup joins Herdr session health, dispatches workers under their own identities, and routes work from Graphyard's ledger.
