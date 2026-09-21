<!-- page: Start here | 4 | run Graphyard locally. -->
# Local quickstart

For someone evaluating Graphyard on one machine: what to run before connecting a repository.

## Start Graphyard

Requires Node 24, Git, Docker Engine and Docker Compose.

```sh
git clone https://github.com/cryptob1/graphyard.git
cd graphyard
npm ci
cp .env.example .env
# Replace every example token with a distinct random secret, and set
# GITHUB_REPOSITORY to a repository you own and can push to.
docker compose up -d db
npm run build
npm start
```

## Propose the delivery workflow, then apply it

`node "$GRAPHYARD_CLI" init --scan --url "$GRAPHYARD_URL"` reads package manifests, CI workflows, deploy configuration and test layout, writes one ignored file, `.graphyard/setup-proposal.json` ([a Node and Railway sample](../examples/setup-proposal.json)). Review, then apply with `init --scan --apply` ([what it proposes and reports as drift](operations-reference.md#setup-proposals-and-drift)).

## Create, claim and submit

In the dashboard, create a small task, add its acceptance criteria, move it to Ready; all listed proofs must pass, only the operator's `admin` credential can [revise requirements](coordination.md#revise-requirements-explicitly).

```sh
git fetch origin
node "$GRAPHYARD_CLI" claim GY-1
node "$GRAPHYARD_CLI" worktree GY-1 EPOCH origin/YOUR_BASE_BRANCH
cd .graphyard/worktrees/GY-1-EPOCH
node "$GRAPHYARD_CLI" watch GY-1 EPOCH -- YOUR_AGENT_COMMAND
```
