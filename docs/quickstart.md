<!-- page: Start here | 4 | install locally with `--provider compose` for evaluation. -->
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
verifies health, authenticated status, and webhook delivery. `curl -s
http://127.0.0.1:4310/healthz` names the version and schema generation you are running.

A loopback URL is not reachable from GitHub, so webhook delivery stays unconfirmed on this
provider. That is expected for local evaluation and is reported, not hidden. Graphyard still
polls GitHub, so gates continue to work, more slowly. Use a public provider for real work.

Open `http://127.0.0.1:4310` and sign in with the admin credential file named in the
installation summary.

## Let Graphyard propose the delivery workflow

The plan above detects the CI check names on the base branch, and you name the proofs a CI
runner may submit with `--producer-proof`. Instead of guessing either, run a read-only scan
between `--plan` and `--apply` and let Graphyard propose them:

```sh
cd /path/to/your-writable-repository
node "$GRAPHYARD_CLI" init --scan
```

The scan is read-only. It inspects package manifests, CI workflows, deploy configuration
(Railway, Vercel, Fly, GitHub Pages, Dockerfile/compose), and the test layout, then writes
one ignored file, `.graphyard/setup-proposal.json`, proposing:

- the CI system and the required check names;
- build/test commands with their proof names;
- the deploy target and how to verify a deployed SHA;
- the candidate environment topology (ephemeral, pooled, or partial — see [operations](operations.md#setup-proposals-and-drift));
- the default policy: required checks, GitHub as review provider, and evidence expectations;
- worker/reviewer profiles for the agent runtimes present on this machine;
- the GitHub App registration.

Review the proposal with the operator. A sample proposal for a Node/Railway repository is in
[examples/setup-proposal.json](../examples/setup-proposal.json). On the one-command path the
installer applies it: pass each proposed check as `--required-check NAME` and each proof a
CI runner may submit as `--producer-proof NAME`, and nothing is applied without `--apply`.
`init --scan --apply --url SERVER_URL` is the equivalent for a control plane you deployed by
hand through the [manual fallback](deployment.md#manual-fallback): it writes the managed
`AGENTS.md` section, generates principal credentials with proof grants in
`.graphyard/principals.json` for you to install as `GRAPHYARD_PRINCIPALS`, writes the
worker/reviewer profiles, and performs the GitHub App registration flow. Do not run it against
a control plane the installer created; the installer already holds those identities. If the
repository changes between review and apply, the command refuses and the stored proposal is
left untouched; rerun `init --scan`, review the refreshed proposal, and apply again.
Re-running a matching apply changes nothing and reports drift.

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
