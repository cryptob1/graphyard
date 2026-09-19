<!-- page: Operate Graphyard | 2 | the shortest install path and the App-permission migration an upgrade can require. -->
# Install and upgrade

The shortest supported path from a GitHub repository to an enforcing Graphyard control plane, and the checks that keep an existing installation enforcing after an upgrade. [Onboard a repository](onboarding.md) walks the same steps with Herdr, a master, and a worker; [deployment](deployment.md) covers the hosting choices.

Graphyard is not published to npm yet, so the CLI is invoked from a Graphyard checkout:

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
```

## Fresh installation

1. **Deploy the server** with Postgres and an HTTPS origin, following [deployment](deployment.md). Set `GRAPHYARD_PRINCIPALS` with one cryptographically random token per role, plus `GITHUB_REPOSITORY`, `GITHUB_BASE_BRANCH`, and `GITHUB_CI_APP_IDS`.
2. **Register the control-plane App** from the managed repository checkout:

   ```sh
   cd /path/to/OWNER/REPO
   node "$GRAPHYARD_CLI" github-setup https://YOUR-GRAPHYARD-HOST
   ```

   The manifest requests exactly the [declared control-plane permission set](github.md#app-permissions), including Contents: read and write for the merge queue. Install the App only on the managed repository. Credentials land in `.graphyard/github-app.json` with mode 0600 and are never printed.
3. **Configure the server** with `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET` from that file, then redeploy. At startup the server preflights the installed permissions against the declaration and logs any shortfall.
4. **Verify** with `node "$GRAPHYARD_CLI" doctor` (`appPermissions.missing` must be empty) and `node "$GRAPHYARD_CLI" status`, which reports `appPermissions` and `heldJobs`. Then [require the check](github.md#require-the-check) on the base branch and submit a real pull request; configured is not proof of enforcement.
5. Optionally register [reviewer Apps](github.md#register-the-reviewer-app) with `--reviewer NAME`; each holds only the reviewer declaration and never Contents: write.

## Upgrading an existing installation

Upgrading the server image never changes the GitHub App. A release that needs a new App permission — the merge queue's Contents: write is the first — therefore leaves an already-installed App short until its owner accepts the change, and the server says so instead of failing quietly:

- the startup and five-minute [preflight](github.md#preflight-and-holds) raises an attention item naming the missing permission and the installation page, in the server log, `GET /api/status`, the dashboard, and `graphyard master status` under `controlPlane.attention`;
- integration jobs that need the permission are held rather than retried, so there is no 403 back-off loop and other observations stay fresh;
- `graphyard master init` reports the same attention in its result and points at the migration command.

Upgrade in this order:

1. Back up the database and deploy the tested image as [deployment](deployment.md#backup-upgrade-rollback) describes.
2. Read the attention items: `node "$GRAPHYARD_CLI" doctor`, the dashboard, or `node "$GRAPHYARD_CLI" master status`.
3. On the machine that holds `.graphyard/github-app.json`, run the [migration](github.md#migrating-an-existing-app):

   ```sh
   node "$GRAPHYARD_CLI" github-setup --update-permissions --wait 600
   ```

   It prints the exact browser steps GitHub requires — set the permission on the App, then accept the pending request on the installation — and polls until the installation reports the declared set. It exits nonzero while anything remains.
4. Nothing else is needed. The next preflight sees the accepted permission and releases the held jobs; no restart is required. Confirm with `doctor` that `appPermissions.missing` is empty and `heldJobs` is `0`.

Only the control-plane App gains a permission in this migration. Reviewer Apps keep their own declaration — `github-setup --update-permissions --reviewer NAME` reports any excess grant as a step to reduce it — and worker identities are never Apps. The reasons are in [App permissions](github.md#app-permissions).
