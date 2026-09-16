# Local quickstart

Use this path to evaluate Graphyard on one machine. For a real repository and Herdr fleet, use [repository onboarding](onboarding.md).

## Start Graphyard

Requires Node 24, Docker Engine, and Docker Compose.

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

Open `http://localhost:4310` and sign in with the operator token from `.env`.

Keep this Graphyard checkout running. Clone the configured writable repository separately; worker and worktree commands run there. Graphyard does not accept a pull request whose head belongs to a different repository.

## Create work

Use the UI, or:

```sh
export GRAPHYARD_URL=http://localhost:4310
export GRAPHYARD_TOKEN=YOUR_OPERATOR_TOKEN
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
node "$GRAPHYARD_CLI" create /absolute/path/to/graphyard/examples/work.json
node "$GRAPHYARD_CLI" ready GY-1
```

Acceptance criteria name the proof required. All listed proofs must pass. Operators may revise requirements with `npm run cli -- requirements`; workers cannot weaken their own task.

## Claim and launch a worker

Use a distinct worker token:

```sh
cd /path/to/your-writable-repository
export GRAPHYARD_TOKEN=YOUR_WORKER_TOKEN
node "$GRAPHYARD_CLI" claim GY-1
node "$GRAPHYARD_CLI" worktree GY-1 EPOCH origin/main
cd .graphyard/worktrees/GY-1-EPOCH
node "$GRAPHYARD_CLI" watch GY-1 EPOCH -- YOUR_AGENT_COMMAND
```

Replace `EPOCH` with the value returned by `claim`. `watch` renews the lease and stops the worker when ownership is lost. See [operations](operations.md) for containment and recovery details.

## Submit the PR

Push the assigned branch, open a PR, then:

```sh
node "$GRAPHYARD_CLI" complete GY-1 EPOCH PR_NUMBER
```

Graphyard now evaluates review, CI, acceptance, and merge gates. A trusted producer—not the implementation worker—submits required evidence. GitHub integration must be configured before Graphyard can authorize a merge.

Use [repository onboarding](onboarding.md) to connect GitHub protection, Herdr, and the master-agent flow.
