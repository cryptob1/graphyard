<!-- page: Start here | 0 | plan and install -->
# Install Graphyard

Install for `OWNER/REPO` with the merge writer's deploy key as the only GitHub access. No App, Actions gate or branch protection is needed.

## Hard rules

Never print or commit credentials. Store them outside repositories under `$GRAPHYARD_CONFIG_HOME` (default `~/.config/graphyard`): directories 0700, secrets 0600. Use separate principals for concurrent sessions (`--workers N`). Workers receive no admin, coordinator or producer credentials; producers get only named `--producer-proof` grants.

## Preconditions

Node 24, an OWNER/REPO checkout, exported `GRAPHYARD_CLI`, and repository-admin `gh` login with `repo` scope for deploy-key registration. Worker hosts need [bubblewrap](setup-from-zero.md#1-machine-prerequisites).

### Providers

`compose` needs Docker and Compose. `local` runs the control plane on the host with embedded Postgres; Docker runs its private-root merge trials. `up --local` also chooses [supervised mode](onboarding.md#supervised-mode-up---local).

## Step 1: plan and approve

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

Check `secretsRedacted` and `preflight[].ok`; run each reported fix. Agents apply existing authorization without routine human approval. Only goals and priorities, money and accounts, and credentials for people need human decisions.

## Step 2: apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

Reruns are idempotent. Verify `/healthz`; inspect the provider logs for failures. Compose mounts the checkout at `/repo`.

## Step 3: deploy key

Apply creates `INSTALL/deploy-key` (ed25519, 0600) and registers it read-write with `gh repo deploy-key add` unless listed. Setup restores missing registration. Verify `gh repo deploy-key list -R OWNER/REPO`. Only the merge writer uses it.

## Step 4: summary

Check `health`, `deployKey`, `profiles.master.configured` and the setup operator's `status.role` (admin). The running master uses its agent identity.

## Step 5: first item

Follow [onboarding](onboarding.md#4-prove-the-first-change) through a gated merge and serving.

## Roster

`principal add ID --role ROLE [--grant …] [--proof …]` updates `GRAPHYARD_PRINCIPALS`.

## Upgrading an existing installation

`graphyard upgrade [--to VERSION] [--plan]` needs a clean checkout, `DATABASE_URL` and `GRAPHYARD_URL`. It backs up, deploys Graphyard's origin/main or VERSION, restarts the loop and checks health. `install --source-root DIR` selects source. Older schemas refuse; migrated failures require roll-forward.

## Failure handling

Run preflight's fix, read install logs, check deploy-key login/scope, or wait for another apply's lock. Config must stay outside worktrees.

## Agent execution contract

Preserve gates. Use CLI blockers for genuine failures; park only human decisions.

## Manual fallback (unsupported platforms)

Use [deployment](deployment.md#manual-fallback).

The CLI accepts compose and local providers. Retired remote-provider flags and branch-protection options (`--required-check`, `--review-count`, and `--review-policy github`) are no longer accepted; reviews use agents. Older `install.json` records still load, with retired SSH deployment fields discarded. `init --delivery` accepts only `local`; existing delivery policy records remain readable. Use `principal add|remove` for roster changes and `e2e sync` to publish case definitions. The loop handles merging automatically.
