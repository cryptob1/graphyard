# GitHub enforcement

Graphyard uses a dedicated GitHub App. Its installation token is minted from the App private key and refreshed automatically. The App observes the repository and publishes **`Graphyard / merge`** on the exact PR head commit.

## Create and install the App

In your personal GitHub developer settings, create a GitHub App with:

- Homepage: your Graphyard URL.
- Webhook: `https://YOUR-HOST/api/github/webhook`, with a random webhook secret.
- Repository permissions: Metadata read, Contents read, Pull requests read, Checks read/write, and Administration read (to inspect branch protection).
- Events: Pull request, Pull request review, Check run, Check suite, and Push.
- Install only on the repository managed by this Graphyard instance.

Generate a private key. Configure `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY` (full PEM, secret), `GITHUB_WEBHOOK_SECRET`, `GITHUB_REPOSITORY`, and `GITHUB_BASE_BRANCH` on the server. Redeploy. A webhook ping alone does not prove the integration is working; submit a test PR and inspect the job and check.

The installation ID appears in the installation settings URL. The App ID is in the App's settings. A personal access token is deliberately not a substitute for the dedicated App, because the required check should be bound to a specific producer.

## Require the check

Configure protection on the managed base branch:

1. Require status checks before merging.
2. Require **`Graphyard / merge`**, explicitly bound to this App.
3. Require the branch to be up to date before merging (`strict`).
4. Enforce the rule for administrators.
5. Disable force pushes and branch deletion.
6. Remove bypass privileges from implementation agents. Review any rulesets that add alternate paths around protection.

GitHub may require the App to publish a check before it can be selected in the UI. Submit a linked PR to Graphyard; its initially failing check supplies that name. GitHub plan/repository capabilities may restrict branch protection; if protection cannot be enabled, this is not an enforced installation.

Graphyard reads classic branch protection and refuses its merge gate unless these settings are present. Ruleset-only protection is not supported by the initial verifier; it refuses conservatively. Do not disable a working organizational ruleset to satisfy the MVP: add supported protection or extend the verifier first.

The service does not automatically overwrite repository protection. For this project's first bootstrap commit, push the initial code before requiring the check, then enable it before agent-driven PRs begin. Record that bootstrap boundary in the work ledger.

## What is checked

- The PR is in the configured repository and targets the configured base branch.
- The PR head branch matches the registered workspace for its submission.
- All configured CI check names passed from approved CI App IDs. Pending, skipped, neutral, cancelled, or failing checks do not pass.
- Required independent review approves the current head commit; unresolved change requests refuse.
- Each acceptance proof has trusted evidence for the current head/base/policy tuple, with a pass result, nonzero executed count, and zero skipped count.
- GitHub says the PR is mergeable and is not a draft.
- Required branch protection is independently observed.

By default the configured CI App ID is `15368`; verify the actual app IDs returned by your check runs and adjust `GITHUB_CI_APP_IDS`. A check with the right name from an unknown App cannot satisfy policy.

## Trusted test producers

A green GitHub job does not prove every behavioral criterion. A dedicated producer reads the actual test report, verifies the code under test, and sends Graphyard evidence with its credential and an artifact link. Give it only the proof names it can produce.

Do not expose that credential to arbitrary PR code. Running untrusted code in a job that can read the producer secret lets that code forge evidence. Use a separately controlled reporter or trusted workflow and artifact verification appropriate to your threat model. This MVP authenticates producers; it does not implement GitHub OIDC attestations or cryptographically inspect uploaded artifacts.

## Enforcement boundary

Graphyard controls its ledger immediately; GitHub check publication happens through a separate API. No transaction spans both systems. There can be a delay between a refusal and revocation of a previously successful check, especially during a GitHub or network outage. GitHub does not automatically expire a successful check when Graphyard goes offline.

Strict base protection and commit-specific checks prevent common stale-head/base merges, but they do not provide a universal atomic guarantee for later evidence revocations on the same head. For a stronger boundary, a future merge broker/queue should serialize final authorization and merge under a restricted Git identity. The MVP does not claim that stronger guarantee.

Likewise, a worker with Git credentials can still push its own branch after losing a Graphyard lease. Separate worktrees, individual identities, branch protection, and the `watch` process supervisor reduce interference. They are not a remote filesystem security boundary.

GitHub check runs are commit-scoped, not PR-scoped. An unlinked PR normally lacks the required check, but another PR using the same head commit can inherit a successful check. The MVP does not close that authorization reuse path. A merge broker must bind authorization to the exact PR and restrict alternative merge identities.

A bypassed merge of linked work is recorded as a permanent violation; Graphyard will not silently mark it done after backfilled evidence. Merge observation retains the previously tested base for attribution; it does not independently verify the merge/squash/rebase artifact against that base. Recording a merge SHA is not proof that the resulting artifact was tested.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| UI says GitHub is disconnected | App ID, installation ID, PEM secret, and server restart |
| Job shows 401/403 | App key, installation access, permission approval, repository selection |
| Protection gate refuses | Exact check name, App binding, strict mode, admin enforcement, force/delete settings |
| Acceptance refuses despite green CI | Proof names, producer allowlist, candidate SHA, base SHA, policy revision, skipped count |
| PR changed while observed | Normal optimistic concurrency retry; investigate only if persistent |
| No update after webhook | Signature secret and job errors; periodic polling still runs |

References: [GitHub Checks API](https://docs.github.com/en/rest/checks/runs), [branch protection API](https://docs.github.com/en/rest/branches/branch-protection).
