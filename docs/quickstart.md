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

Open `http://localhost:4310` and sign in with the operator token from `.env`.

Keep this Graphyard checkout running. Clone the configured writable repository separately; Graphyard does not accept a pull request whose head belongs to a different repository.

## Prepare the repository

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

Paste the worker token, press Enter, then press Ctrl-D. Commit the generated `AGENTS.md` and `.gitignore` changes before starting product work.

## Create work

In the UI, create a small task for this repository, add its acceptance criteria, and move it to Ready. All listed proofs must pass. To revise requirements later, an operator runs `node "$GRAPHYARD_CLI" requirements GY-1 revision.json`; workers cannot weaken their own task.

## Claim and launch a worker

Use a distinct worker token:

```sh
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
