<!-- page: Operate Graphyard | 2 | upgrades, readiness. -->
# Install and upgrade

For an operator installing or upgrading a control plane: what to set, and what an upgrade still needs.

## Fresh installation

The seven-step runbook is [onboarding](onboarding.md); the server, Postgres and HTTPS origin are [deployment](deployment.md). Easy to miss: the four [capacity variables](deployment.md#delegation-capacity-variables) set from the principal set you deploy; the [CI producer](deployment.md#ci-producer) `init --scan --apply` registers, whose token `ciProofs.next` names, so later pushes run its [proofs in CI](github.md#proofs-in-ci); and verifying with `graphyard doctor` (`appPermissions.missing` empty) and `graphyard status` before you [require the check](github.md#require-the-check) and submit a real pull request.

## Readiness checklist

`graphyard doctor --profile through-merge|preview-validation|production-verification` prints a checklist for the selected [completion profile](turnkey-delivery-roadmap.md#product-promise-and-boundary).

- **Every item** states what was observed and, when `missing` or `unknown`, the command or setting that resolves it; `unknown` is never `ready`, and an item the command could not judge says what it depends on.
- **Items:** repository remote, control-plane connection and the credential's role, reviewed and applied setup proposal and its drift, dedicated App and the permissions it lacks, discovered required checks, worker profiles, review provider, Playwright suite, immutable environment, runner, collector and builder registrations, approved bundle.
- `production-verification` stays `missing` until release observations ship: an explicit manual proof until then.

## Upgrading an existing installation

Upgrading the server image never changes the GitHub App, so a release needing a new permission leaves an installed App short until its owner accepts it; the [preflight](github.md#preflight-and-holds) holds the jobs that need it.

1. Back up the database, deploy the tested image ([deployment](deployment.md#backup-upgrade-restore)).
2. Read the attention items (`graphyard doctor`, the dashboard, or `graphyard master status`).
3. On the machine holding `.graphyard/github-app.json` run the [migration](github.md#migrating-an-existing-app): `graphyard github-setup --update-permissions --wait 600`, polling until the installation reports the declared set.
4. The next preflight releases the held jobs without a restart; `doctor` confirms `appPermissions.missing` is empty and `heldJobs` is `0`.
