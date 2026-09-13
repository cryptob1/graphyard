# First enforced PR and self-hosting readiness

This guide connects the bootstrap components into one supervised loop. Creating a GitHub App, configuring a workflow, or seeing green CI is not by itself proof that the loop works.

## Discover the repository

From the managed repository, using a checkout of Graphyard:

```sh
node /path/to/graphyard/bin/graphyard.mjs init
```

The command finds the GitHub origin, package scripts, supported test framework packages, and workflow files. It saves a proposal in ignored `.graphyard/project.json` and appends agent instructions without replacing existing instructions. Confirm the actual CI job names before using the proposed `test` and `typecheck` requirements. Discovery does not execute scripts or infer that tests passed.

## Register the dedicated GitHub App

```sh
node /path/to/graphyard/bin/graphyard.mjs github-setup https://YOUR-GRAPHYARD-HOST
```

Open the printed loopback URL. If the CLI runs over SSH, forward local port 4311 to that machine's port 4311 and open `http://127.0.0.1:4311` in your own browser. Sign in to GitHub, register the preconfigured App, and install it only on the managed repository. Keep the CLI running until the page says the installation was verified.

The [GitHub App manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) supplies the App ID, webhook secret, and private key directly to the local callback. A random state value binds registration to the setup session. The private App requests check-write permission and read access to contents, PRs, metadata, and protection; it cannot write code or merge. Registration currently targets personal accounts, not organization-owned Apps.

Credentials are saved in `.graphyard/github-app.json` with mode 0600. Setup adds `.graphyard/` to `.gitignore` first and refuses an already tracked credential directory. Rerunning setup resumes a saved registration. Do not copy this file into an implementation worktree or paste it into chat. Only the metadata/confirmation is shown in the browser. Graphyard checks installation access before saving the installation ID.

## Configure this project's Railway deployment

These helpers target `cryptob1/graphyard` and its existing Railway service. For another installation, use the deployment guide and configure the equivalent variables/environment yourself.

```sh
node scripts/configure-integrations.mjs --plan
node scripts/configure-integrations.mjs --apply
npx @railway/cli config plan
```

The helper restricts the `graphyard-reporting` GitHub environment to deployments from the `main` branch, verifies that restriction, generates a producer token in memory, and stores it only in Railway principals and that restricted environment. Its only trusted proof is `integration:claim-safety`. The helper also stages App credentials in Railway. It does not deploy. Re-running rotates the reporter credential. This helper uses the local bootstrap principal list as the principal configuration; reconcile additional operator-created identities before using it on a modified installation.

Review the Railway plan, apply infrastructure changes as needed, and deploy reviewed code. `.railway/railway.ts` preserves the App secret variables. Do not put the reporter token into repository-wide GitHub secrets, a PR-controlled job, or worker configuration.

Run `graphyard doctor` with an individual token and the deployed `GRAPHYARD_URL`. It distinguishes API connectivity and configured GitHub credentials; it deliberately does not equate those with demonstrated enforcement.

## Bootstrap the trusted runner

The trusted workflow and its scripts must reach protected `main` through normal review before they can publish evidence. The initial runner cannot provide independent proof for its own introduction. CI tests the harness and container, and the operator reviews that bootstrap boundary.

`Trusted Graphyard acceptance` has two jobs:

1. The exercise job checks out the protected harness revision, reads the PR's exact head and base from GitHub, prepares their merged tree, builds a container, and tests its HTTP API against isolated Postgres. Candidate code receives only disposable test principals. It has no production token, Docker socket mount, host workspace mount, or reporter secret. The harness and report file remain outside the candidate container.
2. The publication job runs separately under the main-only `graphyard-reporting` environment. It verifies the exact required case inventory, workflow run/attempt, harness commit, target work and policy, and observed head/base/PR before submitting evidence. It never executes candidate code or artifact contents. Known failed executions publish failing evidence, so a later failure can supersede a previous pass.

The five named cases cover API authorization, competing claims, stale epochs after reassignment, worker evidence trust, and unfinished dependencies. The proof does **not** claim lease recovery across machines, semantic correctness of arbitrary features, or production verification. Extend protected proof definitions deliberately; do not turn arbitrary PR-supplied reports into trusted evidence.

The runner currently supports public same-repository PRs targeting `main`, using Linux GitHub-hosted runners and Docker. It runs on explicit dispatch rather than automatic environment events. Container isolation relies on the runner/kernel security boundary. Infrastructure failure before a candidate can be prepared, workflow cancellation, or publication failure may prevent new evidence from arriving; inspect the failed run and current gate instead of assuming the old result was revoked.

The normal PR CI container job is validation only. Its harness may be changed by the PR and it receives no reporter credential, so its output is never promoted to trusted acceptance evidence.

## Observe refusal, then acceptance

Create a small work item requiring `integration:claim-safety`, along with the existing CI and independent-review requirements. Use the assigned `graphyard/…` branch and workspace. Submit the PR through Graphyard and allow the GitHub adapter to observe it.

Before acceptance proof exists, `Graphyard / merge` must be unsuccessful and the UI must name the missing proof. Once the App has published that check, bind it without replacing existing CI/review requirements:

```sh
node scripts/protect-github.mjs --plan
node scripts/protect-github.mjs --apply
```

Inspect GitHub's mergeability state; do not attempt an unsafe merge as a test. Obtain independent review on the current head, then run:

```sh
gh workflow run acceptance.yml --ref main \
  -f pr=PR_NUMBER -f work_id=WORK_UUID -f policy_revision=1
```

Inspect the report artifact, Graphyard evidence, and App-owned check. Push a new commit: the old evidence must no longer satisfy acceptance. Run the protected acceptance workflow again for the new candidate and obtain current-head review. Only when all gates pass should the App check succeed. After a reviewed merge, Graphyard should record the observed merge and prior authorization.

Do not remove a review requirement because the only available GitHub identity also authored the PR. That is an unresolved bootstrap review dependency, not passing evidence. Likewise, the App check still has the cross-system revocation and commit-reuse limits documented in the enforcement guide; this workflow does not implement a restricted merge broker.

## When to use Graphyard on Graphyard

Start supervised self-hosting only after the real refusal-to-acceptance lifecycle is demonstrated, the trusted workflow is on protected main, and the deployed revision is known. At that point, claim subsequent implementation work and use assigned worktrees instead of treating more development as bootstrap.

Use the existing Herdr plugin and individual worker tokens. First validate one supervised worker, then the two-host recovery case: competing claims, worker loss, epoch advancement, and rejection of the old owner. Record independent evidence before expanding concurrency. Deployment/production gates, generic E2E orchestration, file-conflict warnings, and the merge broker remain later milestones.
