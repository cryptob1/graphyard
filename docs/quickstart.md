# Local quickstart

Use this path to evaluate Graphyard on one machine. For a real deployment and a Herdr fleet,
follow [install](install.md) with `--provider railway`, `hetzner`, or `docker-host`, then
[repository onboarding](onboarding.md).

## Install a local control plane

Requires Node 24, Git, Docker Engine, Docker Compose, and the GitHub CLI signed in as an
account that administers the repository you will manage.

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
cd /path/to/your-writable-repository

node "$GRAPHYARD_CLI" install --provider compose --repo OWNER/REPO --plan
node "$GRAPHYARD_CLI" install --provider compose --repo OWNER/REPO --apply
```

`--provider compose` builds the image from your Graphyard checkout, starts Postgres and the
application on this machine, and publishes the server on `http://127.0.0.1:4310`. Use
`--port N` if that port is taken. The installer generates one credential per role under
`~/.config/graphyard/<install>/`, runs the GitHub App flow — one browser confirmation — and
verifies health, authenticated status, and webhook delivery.

A loopback URL is not reachable from GitHub, so webhook delivery stays unconfirmed on this
provider. That is expected for local evaluation and is reported, not hidden. Graphyard still
polls GitHub, so gates continue to work, more slowly. Use a public provider for real work.

Open `http://127.0.0.1:4310` and sign in with the admin credential file named in the
installation summary.

## Create work

In the UI, create a small task for this repository, add its acceptance criteria, and move it
to Ready. All listed proofs must pass. Only an admin can [revise
requirements](coordination.md#revise-requirements-explicitly); workers cannot weaken their
own task.

## Claim and launch a worker

The installer already registered a worker profile for each authenticated agent runtime it
found. Dispatch one through the master:

```sh
node "$GRAPHYARD_CLI" master status
node "$GRAPHYARD_CLI" master dispatch GY-1 PROFILE_NAME
```

Or drive a worker directly, using that worker's own credential:

```sh
git fetch origin
node "$GRAPHYARD_CLI" claim GY-1
node "$GRAPHYARD_CLI" worktree GY-1 EPOCH origin/YOUR_BASE_BRANCH
cd .graphyard/worktrees/GY-1-EPOCH
node "$GRAPHYARD_CLI" watch GY-1 EPOCH -- YOUR_AGENT_COMMAND
```

Replace `EPOCH` with the value returned by `claim`. A direct `watch` invocation stops the
worker process group on Unix. On Windows it can stop only the direct child, so use external
containment if the agent may spawn descendants. Foreground Herdr launches have stricter host
requirements; see [Herdr integration](herdr.md) and [operations](operations.md).

## Submit the PR

Push the assigned branch, open a PR, then:

```sh
node "$GRAPHYARD_CLI" complete GY-1 EPOCH PR_NUMBER
```

Graphyard now evaluates review, CI, acceptance, and merge gates. A trusted producer — not the
implementation worker — submits required evidence; grant one with `--producer-proof NAME`
when you install. Done means Graphyard observed an authorized merge.
