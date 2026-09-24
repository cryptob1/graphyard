<!-- page: Start here | 4 | install locally with `--provider compose` for evaluation. -->
# Local quickstart

Evaluate Graphyard on one machine. For a real deployment follow [install](install.md) with `--provider railway`, `hetzner` or `docker-host`, then [repository onboarding](onboarding.md).

## Install a local control plane

Requires Node 24, Git, Docker Engine and Compose, and the GitHub CLI signed in as a repository administrator.

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
cd /path/to/your-writable-repository
node "$GRAPHYARD_CLI" init --scan          # optional: read-only proposal in .graphyard/setup-proposal.json
node "$GRAPHYARD_CLI" install --provider compose --repo OWNER/REPO --plan
node "$GRAPHYARD_CLI" install --provider compose --repo OWNER/REPO --apply
```

The server listens on `http://127.0.0.1:4310` (`--port N` to change). Credentials are written under `~/.config/graphyard/<install>/`; sign in to the dashboard with the admin credential file named in the summary. GitHub cannot reach a loopback webhook, so gates work by polling, more slowly.

`init --scan` proposes CI check names, proof names, deploy target and launch profiles ([example](../examples/setup-proposal.json), [drift](operations-reference.md#setup-proposals-and-drift)); pass them to the installer as `--required-check NAME` and `--producer-proof NAME`.

## Create, claim and submit

Create a small task with acceptance criteria in the dashboard and move it to Ready. Then dispatch through the master:

```sh
node "$GRAPHYARD_CLI" master status
node "$GRAPHYARD_CLI" master dispatch GY-1 PROFILE_NAME
```

or drive a worker directly with its own credential:

```sh
git fetch origin
node "$GRAPHYARD_CLI" claim GY-1
node "$GRAPHYARD_CLI" worktree GY-1 EPOCH origin/YOUR_BASE_BRANCH
cd .graphyard/worktrees/GY-1-EPOCH
node "$GRAPHYARD_CLI" watch GY-1 EPOCH -- YOUR_AGENT_COMMAND
# push the branch, open a PR, then:
node "$GRAPHYARD_CLI" complete GY-1 EPOCH PR_NUMBER
```

A proof producer, never the worker, submits the evidence. Done means Graphyard observed an authorized merge. Only the human operator or a scoped operator agent can [revise requirements](coordination.md#revise-requirements-explicitly).
