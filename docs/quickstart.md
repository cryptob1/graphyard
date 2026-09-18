# Local quickstart

Use this path to evaluate Graphyard on one machine. For a real repository and Herdr fleet, use [repository onboarding](onboarding.md).

## Start Graphyard

Requires Node 24, Git, Docker Engine, and Docker Compose.

```sh
git clone https://github.com/cryptob1/graphyard.git
cd graphyard
npm ci
cp .env.example .env
# Replace every example token with a distinct random secret.
# Set GITHUB_REPOSITORY to a repository you own and can push to.
docker compose up -d db
npm run build
npm start
```

Open `http://localhost:4310` and sign in with the operator token from `.env`. `curl -s http://localhost:4310/healthz` names the version and schema generation you are running.

Keep this Graphyard checkout running. Clone the configured writable repository separately; Graphyard does not accept a pull request whose head belongs to a different repository.

## Prepare the repository

### Propose the delivery workflow first

Instead of hand-authoring check names, proof names, and profiles, let Graphyard inspect the repository and propose them:

```sh
cd /path/to/your-writable-repository
node "$GRAPHYARD_CLI" init --scan --url "$GRAPHYARD_URL"
```

The scan is read-only. It inspects package manifests, CI workflows, deploy configuration (Railway, Vercel, Fly, GitHub Pages, Dockerfile/compose), and the test layout, then writes one ignored file, `.graphyard/setup-proposal.json`, proposing:

- the CI system and the required check names;
- build/test commands with their proof names;
- the deploy target and how to verify a deployed SHA;
- the candidate environment topology (ephemeral, pooled, or partial — see [operations](operations.md#setup-proposals-and-drift));
- the default policy: required checks, GitHub as review provider, and evidence expectations;
- worker/reviewer profiles for the agent runtimes present on this machine;
- the GitHub App registration.

Review the proposal with the operator, then apply it. A sample proposal for a Node/Railway repository is in [examples/setup-proposal.json](../examples/setup-proposal.json):

```sh
node "$GRAPHYARD_CLI" init --scan --apply --url "$GRAPHYARD_URL"
```

Applying writes the managed `AGENTS.md` section, generates principal credentials with proof grants in `.graphyard/principals.json`, writes the worker/reviewer profiles, and performs the GitHub App registration flow. Nothing is applied without `--apply`. If the repository changes between review and apply, the command refuses and the stored proposal is left untouched; rerun `init --scan`, review the refreshed proposal, and apply again. Re-running a matching apply changes nothing and reports drift.

### Connect a worker

From the writable repository, connect a worker and install the `.graphyard/` ignore rule:

```sh
export GRAPHYARD_URL=http://localhost:4310
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
cd /path/to/your-writable-repository
node "$GRAPHYARD_CLI" init \
  --url "$GRAPHYARD_URL" \
  --host-id local-evaluation \
  --token-stdin
```

Paste the worker token, press Enter, then press Ctrl-D. Commit the generated `AGENTS.md` and `.gitignore` changes, push or merge that commit into the configured base branch, and fetch it before starting product work.

## Create work

In the UI, create a small task for this repository, add its acceptance criteria, and move it to Ready. All listed proofs must pass. Only an admin can [revise requirements](coordination.md#revise-requirements-explicitly); workers cannot weaken their own task.

## Claim and launch a worker

Use a distinct worker token:

```sh
git fetch origin
node "$GRAPHYARD_CLI" claim GY-1
node "$GRAPHYARD_CLI" worktree GY-1 EPOCH origin/YOUR_BASE_BRANCH
cd .graphyard/worktrees/GY-1-EPOCH
node "$GRAPHYARD_CLI" watch GY-1 EPOCH -- YOUR_AGENT_COMMAND
```

Replace `EPOCH` with the value returned by `claim`. A direct `watch` invocation stops the worker process group on Unix. On Windows it can stop only the direct child, so use external containment if the agent may spawn descendants. Foreground Herdr launches have stricter host requirements; see [Herdr integration](herdr.md) and [operations](operations.md).

## Submit the PR

Push the assigned branch, open a PR, then:

```sh
node "$GRAPHYARD_CLI" complete GY-1 EPOCH PR_NUMBER
```

Graphyard now evaluates review, CI, acceptance, and merge gates. A trusted producer—not the implementation worker—submits required evidence. GitHub integration must be configured before Graphyard can authorize a merge.

Use [repository onboarding](onboarding.md) to connect GitHub protection, Herdr, and the master-agent flow.
