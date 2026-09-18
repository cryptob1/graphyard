# GitHub enforcement

Graphyard uses a dedicated GitHub App. Its installation token is minted from the App private key and refreshed automatically. The App observes the repository and publishes **`Graphyard / merge`** on the exact PR head commit.

## Create and install the App

For guided personal-account registration, use `graphyard github-setup HTTPS_URL`; it creates a local manifest callback and saves credentials without manual key copying. See [repository onboarding](onboarding.md). The manual setup below remains available for organization accounts and existing Apps.

In your personal GitHub developer settings, create a GitHub App with:

- Homepage: your Graphyard URL.
- Webhook: `https://YOUR-HOST/api/github/webhook`, with a random webhook secret.
- Repository permissions: Metadata read, Contents read, Pull requests read/write, Issues read (for comment webhooks), Checks read/write, and Administration read (to inspect branch protection).
- Events: Pull request, Pull request review, Check run, Check suite, Issue comment, and Push.
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

## Inspect enforcement

Configured is not enforced. `scripts/verify-enforcement.mjs` joins the live GitHub and Graphyard observations for one submitted work item into a single read-only report:

```sh
node scripts/verify-enforcement.mjs GY-N [PR_NUMBER]
```

It reads the managed repository, base branch and dedicated App ID from the live server, then reports which App published `Graphyard / merge` on the exact PR head, the branch-protection settings the merge verifier requires, every Graphyard gate with its refusal reasons, and GitHub's own mergeability. It paginates check runs and refuses a mismatched candidate, a stale Graphyard observation, or a blocking GitHub merge state. Every context branch protection requires — not only `Graphyard / merge` — must have a completed successful run from the App that context is bound to. Immediately before reporting, it re-reads the work item, pull request, required check runs, and branch protection and refuses if their merge-controlling state changed during collection, including the work revision, exact commits, base ref, PR state (`state`, `draft`, `merged`, `mergeable`, or `mergeable_state`), and the run set of every protected required context. It then reads server time once more, after those re-reads, and judges observation freshness against it, so collection time counts against the Graphyard observation exactly as it does for the merge verifier. The verdict is `refused` while any gate, protection requirement or GitHub state would block the merge, and `permitted` only when all of them currently allow it. Notes call out what the verifier does not read, including repository rulesets, and a successful check inherited from another pull request on the same commit.

The report is an inspection artifact, not evidence. It submits nothing, merges nothing and changes no protection. It needs `gh` authenticated with repository administration read and an individual Graphyard credential. Only an operator may attest a `manual:` proof such as `manual:github-enforcement`, and Graphyard re-verifies the exact candidate immediately before any merge, so a `permitted` verdict describes one observation rather than a standing authorization.

## Dashboard candidate links

Work cards and the work-detail Ownership section show `PR #N`, and Ownership shows the whole 40-character candidate SHA rather than an abbreviation, so the exact commit the gates decided on can be read, selected, and copied. When GitHub is configured, both are links into that repository: `https://github.com/<owner>/<repo>/pull/<N>` and `https://github.com/<owner>/<repo>/commit/<sha>`. Destinations derive only from the configured repository identity plus the observed candidate's numeric PR number and full hexadecimal SHA; candidate-authored values can never select a URL. Links open in a new tab with accessible names that begin with the visible reference (`PR #12, open pull request for GY-7 in GitHub`) and a visible keyboard focus ring, and activating one does not change dashboard selection. A card is a plain container, not a button: its title is the selection control that opens the work detail, and the PR link sits beside that control rather than inside it, so assistive technology announces both. Clicking anywhere else on the card still opens the detail. The SHA stays ordinary text: double-click it, or drag from the text beside it, to select and copy the value. Without a configured GitHub repository, or when a reference fails validation (for example a legacy abbreviated SHA), the reference renders as selectable plain text instead of a link.

## Trusted test producers

A green GitHub job does not prove every behavioral criterion. A dedicated producer reads the actual test report, verifies the code under test, and sends Graphyard evidence with its credential and an artifact link. Give it only the proof names it can produce.

Do not expose that credential to arbitrary PR code. Running untrusted code in a job that can read the producer secret lets that code forge evidence. Use a separately controlled reporter or trusted workflow and artifact verification appropriate to your threat model. This MVP authenticates producers; it does not implement GitHub OIDC attestations or cryptographically inspect uploaded artifacts.

## Enforcement boundary

Graphyard controls its ledger immediately; GitHub check publication happens through a separate API. No transaction spans both systems. There can be a delay between a refusal and revocation of a previously successful check, especially during a GitHub or network outage. GitHub does not automatically expire a successful check when Graphyard goes offline.

Strict base protection and commit-specific checks prevent common stale-head/base merges, but they do not make GitHub and Postgres one atomic system. The recommended master command narrows that boundary with a short-lived execution authority, a final transactional GitHub re-observation, and an exact-head merge call. Graphyard accepts delivery only when the observed merge follows that verified authority. Restricting every alternative GitHub merge identity still requires repository or organization administration outside Graphyard.

Likewise, a worker with Git credentials can still push its own branch after losing a Graphyard lease. Separate worktrees, individual identities, branch protection, and the `watch` process supervisor reduce interference. They are not a remote filesystem security boundary.

GitHub check runs are commit-scoped, not PR-scoped. An unlinked PR normally lacks the required check, but another PR using the same head commit can inherit a successful check. Graphyard's merge execution binds accepted delivery to its exact work item, PR, head, base, policy revision, and final verification. Repository rules must still prevent other identities from merging outside that path if prevention, rather than detection and refusal, is required.

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

## Agent review approval (Codex cloud adapter)

A work policy can select `reviewProvider: "codex"` while retaining `review: true`. The alternative `github` (also the default for existing tasks) requires a formal independent GitHub approval. Human product/visual acceptance remains a separate criterion; selecting agent code review does not bypass it, CI, dependencies, or deployment checks.

Graphyard dispatches a fresh `@codex review` comment through its own GitHub App and records the returned comment ID against the exact head SHA, base SHA, and policy revision. The comment includes a unique request marker. Arbitrary comments and previously posted manual requests cannot be imported as approvals. The App needs **Pull requests: write** to post PR comments and **Issues: read** to subscribe to the `issue_comment` event; Contents remains read-only. GitHub documents the comment-event permission in its [webhook reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment). Existing installations must update and approve the permission before enabling this policy. Codex cloud must be connected. This installation has produced both automatic summary/reaction results and standalone clean-result comments following App requests. Enable automatic reviews for PRs and new commits; do not assume a successful comment POST launched a review. The recorded request establishes a candidate/policy boundary, but only independently observed completion can satisfy it.

The adapter also accepts the hosted connector’s explicit “Didn’t find any major issues” result comment (bare verdict, thumbs-up/celebration suffixes, or a small closed allowlist of benign courtesy phrases, including the observed “Hooray!”, “Breezy!” and “Chef’s kiss.” variations) with a reviewed commit. It requires both numeric bot/App identities, an unedited result created strictly after the recorded request, resolution to the full current head, no findings since the request, no newer provider activity, and no running reactions. Only one of the exact observed legacy or current informational footers, or trailing whitespace alone, may follow the reviewed-commit line; appended findings or unknown content refuse. The connector may update its authenticated summary immediately after the result; Graphyard accepts one such update only when it reports a manual review completed for the same exact head within ten seconds. A running summary, another commit or trigger, a later update, multiple matching summaries, or any other newer provider activity refuses. The result, request, and matching summary are reread alongside current comments/reviews before acceptance, and their bodies and timestamps must remain unchanged. An older summary left “Running” does not override a newer explicit result. The verdict and those courtesies are recognized with either the ASCII or the typographic apostrophe, as the authenticated connector has posted both; the spelling alone changes nothing else, so every identity, request-correlation, exact-head, freshness, and no-findings check here still applies unchanged. This means the provider reported no major issues, not that every possible defect has been disproved.

The adapter supports the observed **PR opened**, **New commits**, and **Manual request** summary formats from OpenAI's hosted Codex connector. An automatic review must complete in a strictly later timestamp second than Graphyard recorded its current candidate request (same-second ordering is ambiguous and refuses), and its fresh clean reaction must be on the PR. A manual review must respond on the recorded request comment. It requires the known numeric bot and App identities, a completed summary, GitHub resolution of the displayed abbreviated commit to the full current head, the original unedited Graphyard request, and a fresh clean-review reaction from the Codex bot strictly after completion (same-second reactions refuse). Reviews that publish findings/output, a remaining running reaction, stale reactions, unknown formats, missing records, and collection errors refuse approval. Mutable evidence is reread before accepting the snapshot, including the complete provider-comment list so added, removed, or edited summaries and newer provider activity refuse approval. Reviews are bound to Graphyard's recorded request rather than trusting an editable summary as the sole commit binding.

For merged PRs, review validation retains the previously tested base, just as candidate attribution does; GitHub may already report an advanced base branch. Open PRs whose base changes require a new review.

A fresh clean re-review can supersede earlier Codex findings. Marking conversations resolved alone never counts. Native outstanding `CHANGES_REQUESTED` reviews still block. This does not reinterpret a Codex reaction as a GitHub `APPROVED` event: Graphyard's own required check enforces the selected agent-review policy.

The API/CLI accepts an explicit operator revision for existing work:

```sh
graphyard reviewpolicy GY-N codex CURRENT_POLICY_REVISION "Adopt independent Codex cloud review"
graphyard rereview GY-N
```

The first command preserves the criteria and CI requirements, increments the policy revision, appends audit history, invalidates prior acceptance evidence, and queues reconciliation. Workers cannot change policy. A currently leased worker can request re-review with `rereview GY-N EPOCH`; operators do not need an epoch. Head/base/policy changes cause a new request during reconciliation. The dashboard exposes provider selection and re-review to operators. Old evidence remains visible but must be regenerated for the new policy revision.

### Branch protection migration

GitHub's native required approval count is separate from Graphyard's gate. For repositories adopting agent review, retain strict checks, enforced administrator protection and the App-bound `Graphyard / merge` check, but remove the native approval-count/last-push requirement once reviewed code supporting the adapter is deployed. Otherwise GitHub will continue demanding a formal approval even after Graphyard passes.

```sh
node scripts/protect-github.mjs --plan --agent-reviews
# After deployment and verification, with an individual Graphyard connection:
node scripts/protect-github.mjs --apply --agent-reviews
```

The default helper behavior still preserves native review requirements. The explicit migration refuses to apply unless the configured live server advertises Codex review support and administrator enforcement is active. Check organization rulesets separately. Changing branch protection does not change individual task policies; migrate those explicitly and regenerate acceptance evidence. Tasks still using native GitHub review require a nonzero native approval count, stale-review dismissal and last-push approval. They remain blocked after the branch switches to agent-only review until an operator explicitly adopts the Codex policy. This prevents public read-only approvals from replacing GitHub’s eligible-reviewer enforcement. The adapter's own introduction still needs an independently reviewed bootstrap path; it cannot approve its own installation.

### Limits and recovery

Codex comments/reactions are a provider UI protocol, not a versioned approval API. The adapter refuses unrecognized formats rather than guessing. Hosted review behavior, including the first clean automatic result and whether App-originated mentions execute, must be demonstrated on this installation; fixtures do not prove cloud execution. GitHub remains a trusted administration boundary. Cross-system revocation and the merge-broker limitations above still apply. If the App posts a request but persistence loses a revision/job race, a retry may post another request; the unrecorded request cannot approve work. An automatic result that predates the recorded candidate request does not count. Updating the PR branch triggers a new automatic review; merely resolving threads does not. If the hosted connector ignores App mentions, the re-review button can record a request but cannot itself guarantee dispatch. The gate stays closed until a supported fresh result arrives. Claude and other providers need their own authenticated adapters; they are not treated as Codex based on display names.

Delayed merge observations validate against the policy revision in the historical verified execution at the actual merge time. A later operator policy change cannot retroactively classify that merge as unauthorized; differences under the current policy are recorded as post-merge follow-up.

GitHub's whole-second merge timestamps leave an ambiguous interval. The master waits for the next whole-second boundary after final verification, and the execution and evidence must remain valid through the reported second. A cancellation inside that interval or an unverified direct merge is refused. Inspect ambiguous delivery records rather than rewriting the audit ledger.

Graphyard conditionally revalidates cached GitHub GET responses with ETags. Cached data counts only after GitHub returns `304 Not Modified`; a failed request never falls back to cached evidence. The cache is bounded to 256 URL entries per process. Identical completed check output is not rewritten, but candidate and job guards still run. Successful check output records head/base/policy without the ever-changing polling revision.

Rate/access refusals (403/429) pause that process's GitHub client for at least one minute, honor `Retry-After` and exhausted-quota reset headers, and increase the fallback delay for repeated refusals. These errors remain visible; stale observations cannot satisfy gates. Restarted replicas have independent cooldown/cache state and must observe fresh rate-limit headers. This follows [GitHub's API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api); large installations will still need shared request budgeting.

Concurrent jobs share one installation-token refresh. Token creation uses the same rate-limit cooldown as repository reads and writes, so an authentication refusal cannot trigger a fresh token request for every queued job.

The agent-review migration refuses repositories that require CODEOWNERS approval before making any protection changes. The current adapter proves an independent Codex review, not approval by a configured owner. Define an explicit ownership-review policy first; the helper does not silently remove that additional requirement. This applies to both preview and apply.

Draft and closed, unmerged PRs wait at a refusing gate without dispatching review requests or raising integration-job errors. Mark the PR ready or reopen it to resume dispatch. If the PR changes between observation and dispatch/publication, the stale snapshot is rejected and retried through the normal coordination-retry path.

Hosted Codex varies courtesy text after its fixed clean verdict. The adapter normalizes case and terminal periods/exclamation marks for a closed allowlist (for example, “Nice work”, “Bravo”, and “Keep it up”). It still requires the exact clean verdict and reviewed commit, rejects unknown or contradictory suffixes, and permits only the recognized informational footer afterward. This does not interpret arbitrary prose as approval.

Codex capability is advertised only when the active installation token confirms Pull requests: write, Issues: read (or write), and Checks: write. Token authentication errors or missing permissions disable the advertised capability, and protection migration refuses older/unverified servers. Accept updated GitHub App permissions before migration; credentials are never returned by the status API. Permission observations refresh with installation authentication.

The dashboard disables Codex provider selection and re-review when the server does not advertise verified support, with an explanation to check the App connection and permission updates. Switching an existing task back to formal GitHub review remains available to the operator.

Capability verification also checks the installation token’s paginated repository inventory and records the matched repository ID/name. A configured name or access to a public repository does not prove installation membership. Missing membership or an unavailable inventory disables Codex support and refuses the protection migration.

### Unsupported Codex result formats

Known clean-result courtesy variants observed while dogfooding (including “Keep them coming!”, “Another round soon, please!”, “Swish!”, “You’re on a roll!”, “Already looking forward to the next diff.” and “Can’t wait for the next one!”) use the same exact verdict/commit contract. They do not bypass identity, freshness, findings, request binding or final rereads. Unknown prose refuses with an explicit unsupported-format explanation. An operator should inspect the actual result and add a tested provider contract or request a fresh review; resolving comments or editing the result does not approve it. The adapter remains a conservative compatibility layer, not a stable provider API guarantee.

The “Can’t wait for the next one!” compatibility fixture comes from the [authenticated PR #12 result](https://github.com/cryptob1/graphyard/pull/12#issuecomment-5673722335). It adds one exact benign suffix; contradictory continuation, edited results and unknown wording still refuse.

The same contract recognizes the exact `:rocket:` suffix from the [subsequent authenticated PR #12 clean result](https://github.com/cryptob1/graphyard/pull/12#issuecomment-5673779337); emoji followed by findings or other prose is still refused.
