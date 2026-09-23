<!-- page: Operate Graphyard | 2 | upgrades, readiness. -->
# Install and upgrade

For an operator installing or upgrading a control plane: what to set, and what an upgrade still needs.

## Fresh installation

The seven-step runbook is [onboarding](onboarding.md); the server, Postgres and HTTPS origin are [deployment](deployment.md). Easy to miss: the four [capacity variables](deployment.md#delegation-capacity-variables) (`GRAPHYARD_MAX_SLICE_LEADS`, `GRAPHYARD_MAX_ENGINEERS_PER_LEAD`, `GRAPHYARD_MIN_REVIEWERS`, `GRAPHYARD_MAX_REVIEWERS`) set from the principal set you deploy; the [CI producer](deployment.md#ci-producer) `init --scan --apply` registers, whose token `ciProofs.next` names, so later pushes run its [proofs in CI](github.md#proofs-in-ci); and verifying with `graphyard doctor` (`appPermissions.missing` empty) and `graphyard status` before you [require the check](github.md#require-the-check) and submit a real pull request.

## Readiness checklist

`graphyard doctor --profile through-merge|preview-validation|production-verification` prints a checklist for the selected [completion profile](turnkey-delivery-roadmap.md#product-promise-and-boundary).

- `production-verification` stays `missing` until release observations ship: an explicit manual proof until then.

## Upgrading an existing installation

Upgrading the server image never changes the GitHub App, so a release needing a new permission leaves an installed App short until its owner accepts it; the [preflight](github.md#preflight-and-holds) holds the jobs that need it.

1. Back up the database, deploy the tested image ([deployment](deployment.md#backup-upgrade-restore)).
2. Read the attention items (`graphyard doctor`, the dashboard, or `graphyard master status`).
3. On the machine holding `.graphyard/github-app.json` run the [migration](github.md#migrating-an-existing-app): `graphyard github-setup --update-permissions --wait 600`, polling until the installation reports the declared set.
