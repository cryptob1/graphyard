import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildIdentity, cliCommit } from '../protocol-version.js';
import { candidateWorkflowFile, promotionWorkflowFile, type DeliveryPolicy, type GateCheck } from '../model/delivery-policy.js';

// ---------------------------------------------------------------------------
// The release-candidate and promotion workflows `graphyard init --apply` writes into a managed
// repository (GY-1102). They are rendered from the repository's delivery policy on the template of
// Graphyard's own .github/workflows/release-candidate.yml, and drive the same `graphyard release`
// commands rather than a parallel implementation: `release cut` tags main's tip as a candidate,
// the per-candidate suites check out that exact SHA, `release uat` moves release/uat to it, the
// deployment adapter brings UAT to that SHA, `release validate` records the verdict, and
// `release promote` refuses any candidate whose UAT record on its exact SHA did not pass. The
// workflow sequences; the CLI enforces.
// ---------------------------------------------------------------------------

export const candidateWorkflowName = 'Graphyard release candidate';
export const promotionWorkflowName = 'Graphyard promotion';
/** The artifact the candidate run leaves for the promotion it triggers: the id of the candidate it validated. */
const candidateArtifact = 'graphyard-candidate';

/**
 * The Graphyard commit the generated workflows run the CLI from: the build's own commit when the
 * deployment stamps one that origin/main holds, else the newest commit of this checkout that
 * origin/main already holds, so the pin names a ref GitHub can serve (package.json's version has
 * no published tag or package). A stamp from a local or branch deploy that never reached
 * origin/main falls back to that merge-base; without a checkout to check against, the stamp stands.
 */
export function publishedCliCommit(env: Record<string, string | undefined> = process.env, run: (command: string, args: string[]) => string = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })): string {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  let published: string | null = null;
  try { published = run('git', ['-C', root, 'merge-base', 'HEAD', 'origin/main']).trim(); } catch { /* no origin/main: fall back to HEAD */ }
  if (published && !/^[0-9a-f]{40}$/i.test(published)) published = null;
  const stamped = buildIdentity(env).commit;
  const reachable = (commit: string) => { try { run('git', ['-C', root, 'merge-base', '--is-ancestor', commit, 'origin/main']); return true; } catch { return false; } };
  const commit = stamped && (!published || reachable(stamped)) ? stamped : (published?.toLowerCase() ?? cliCommit(root, run));
  if (!commit) throw new Error('Cannot pin the Graphyard CLI the generated workflows run: this install is not a Git checkout and GRAPHYARD_BUILD_SHA is unset. Set GRAPHYARD_BUILD_SHA to the Graphyard commit this install was built from, then rerun graphyard init --scan --apply');
  return commit;
}

/**
 * The Graphyard CLI the generated workflows run, pinned to the exact commit that rendered them: a
 * floating CLI could change promotion semantics under a pinned candidate. A re-apply after an
 * upgrade re-renders the pin, so an upgrade is a reviewed diff to the workflow.
 * renderReleasePipeline resolves it once per install and hands it to both renderers.
 */
export const pinnedCli = (commit = publishedCliCommit()) => `npx -y github:cryptob1/graphyard#${commit}`;

export interface PipelineOptions {
  /** The branch candidates are cut from. */
  base?: string;
  /** The stack the per-candidate suites need set up before their command runs. */
  stack?: 'node' | 'python' | 'static' | 'unknown';
  cli?: string;
}

export const suiteJobId = (check: string) => `suite-${check.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'check'}`;
const suiteVariable = (check: string) => suiteJobId(check).toUpperCase().replace(/-/g, '_');
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
const block = (text: string, indent: number) => text.split('\n').map(line => `${' '.repeat(indent)}${line}`).join('\n');

/** Per-candidate checks the candidate workflow runs: those with a command. A workflow job runs in its own workflow. */
export const candidateSuites = (policy: DeliveryPolicy): GateCheck[] => policy.mergeGate.perCandidate.filter(entry => entry.command);

function stackSetup(stack: PipelineOptions['stack']) {
  if (stack === 'node') return `      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - run: npm ci`;
  if (stack === 'python') return `      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install -e '.[test]' || pip install -r requirements.txt`;
  return '';
}

/**
 * The step that brings an environment to the candidate's exact SHA through the deployment adapter.
 * Railway services track release/uat and release/production, which `release uat` and `release
 * promote` have already moved, so the Railway step only names that; the command adapter runs the
 * operator's own command with the SHA, and nothing is invented when none is configured.
 * The wait for Railway's build is deliberately the next step's `--wait` against /healthz rather
 * than a Railway API poll: serving the candidate SHA is the condition that matters, it also catches
 * a service tracking the wrong branch, and it keeps a Railway token out of the UAT job.
 */
function deployStep(policy: DeliveryPolicy, environment: 'uat' | 'production', sha: string) {
  const branch = environment === 'uat' ? 'release/uat' : 'release/production';
  if (policy.deploy.adapter === 'railway') return `      - name: Deploy through the railway adapter (the ${environment} environment's service tracks ${branch}, now at the candidate SHA)
        run: echo "Railway deploys ${branch} at $GRAPHYARD_CANDIDATE_SHA"
        env:
          GRAPHYARD_CANDIDATE_SHA: ${sha}`;
  const command = environment === 'uat' ? policy.deploy.uat : policy.deploy.production;
  if (!command) throw new Error(`The command adapter has no ${environment} deploy command; set delivery.deploy.${environment} in graphyard.json to the command that deploys $GRAPHYARD_CANDIDATE_SHA, then rerun graphyard init --scan --apply`);
  return `      - name: Deploy the candidate's exact SHA to ${environment} through the command adapter
        shell: bash
        run: |
${block(command, 10)}
        env:
          GRAPHYARD_CANDIDATE_SHA: ${sha}
          GRAPHYARD_ENVIRONMENT: ${environment}`;
}

export function renderCandidateWorkflow(policy: DeliveryPolicy, options: PipelineOptions = {}) {
  const base = options.base ?? 'main', cli = options.cli ?? pinnedCli();
  const suites = candidateSuites(policy);
  const elsewhere = policy.mergeGate.perCandidate.filter(entry => !entry.command);
  const suiteJobs = suites.map(entry => `  ${suiteJobId(entry.check)}:
    name: ${quoted(`candidate suite: ${entry.check}`)}
    needs: candidate
    if: needs.candidate.outputs.sha != ''
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      CANDIDATE_SHA: \${{ needs.candidate.outputs.sha }}
    steps:
      - name: Refuse anything but a full commit SHA
        shell: bash
        run: '[[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "sha must be a full 40-character commit SHA: $CANDIDATE_SHA" >&2; exit 1; }'
      - uses: actions/checkout@v4
        with: { ref: '\${{ env.CANDIDATE_SHA }}', persist-credentials: false }
${stackSetup(options.stack) ? `${stackSetup(options.stack)}\n` : ''}      - name: ${quoted(`Run ${entry.check} against the candidate`)}
        shell: bash
        run: |
${block(entry.command!, 10)}`).join('\n');
  const suiteArgs = suites.map(entry => ` \\\n            --suite ${quoted(`${suiteJobId(entry.check).slice('suite-'.length)}=test "$${suiteVariable(entry.check)}" = success`)}`).join('');
  const suiteEnv = suites.map(entry => `\n          ${suiteVariable(entry.check)}: \${{ needs.${suiteJobId(entry.check)}.result }}`).join('');
  return `name: ${candidateWorkflowName}
# Generated by graphyard init from the delivery policy in graphyard.json (docs/onboarding.md).
# Edit graphyard.json, then rerun graphyard init --scan --apply; an edit here is overwritten.
# One moving ${base}, a frozen candidate, UAT, then that exact SHA in production. A cut tags ${base}'s
# tip (rc/ID) and nothing else, so merges keep flowing while the candidate is under test. The
# per-candidate suites the pull-request gate never runs check out the candidate's exact SHA; then
# UAT is brought to that SHA through the ${policy.deploy.adapter} adapter and validated, and
# ${promotionWorkflowFile} promotes only a candidate whose UAT record passed on that SHA.
${elsewhere.length ? `# Per-candidate checks that run in their own workflows and are not required on pull requests: ${elsewhere.map(entry => entry.check).join(', ')}.\n` : ''}on:
${policy.candidateSchedule ? `  schedule:\n    - cron: ${quoted(policy.candidateSchedule)}\n` : ''}  workflow_dispatch:
permissions:
  contents: read
concurrency:
  # One candidate at a time; a second request waits rather than cancels.
  group: graphyard-release-candidate
  cancel-in-progress: false
jobs:
  candidate:
    name: cut the candidate
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: write
    outputs:
      id: \${{ steps.cut.outputs.id }}
      sha: \${{ steps.cut.outputs.sha }}
    steps:
      - uses: actions/checkout@v4
        with: { ref: ${base}, fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - name: Cut a release candidate from ${base}'s tip, pinned to its exact SHA
        id: cut
        shell: bash
        run: |
          set -euo pipefail
          ${cli} release cut --base ${base} --trigger "\${{ github.event_name == 'schedule' && 'schedule' || 'manual' }}" | tee cut.json
          echo "id=$(node -p "const r=require('./cut.json'); r.cut ? r.candidate.id : ''")" >> "$GITHUB_OUTPUT"
          echo "sha=$(node -p "const r=require('./cut.json'); r.cut ? r.candidate.sha : ''")" >> "$GITHUB_OUTPUT"
${suiteJobs ? `${suiteJobs}\n` : ''}  uat:
    needs: [${['candidate', ...suites.map(entry => suiteJobId(entry.check))].join(', ')}]
    # Runs once the suites finish, passed or not, so their verdicts join the candidate's UAT record.
    if: \${{ !cancelled() && needs.candidate.outputs.id != '' }}
    runs-on: ubuntu-latest
    timeout-minutes: 120
    permissions:
      contents: write
    environment: uat
    steps:
      - uses: actions/checkout@v4
        with: { ref: ${base}, fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - name: Move release/uat to the candidate's exact SHA
        run: ${cli} release uat "\${{ needs.candidate.outputs.id }}" --base ${base}
${deployStep(policy, 'uat', '${{ needs.candidate.outputs.sha }}')}
      - name: Validate UAT serving the candidate and record the verdict
        # UAT must report the candidate SHA (commit or revision at /healthz); each suite job's result
        # joins the record. A failure files one follow-up item naming the suite and the SHA.
        shell: bash
        run: |
          # shellcheck disable=SC2016
          ${cli} release validate "\${{ needs.candidate.outputs.id }}" --base ${base} --url "$UAT_URL" --wait 1200${suiteArgs}
        env:${suiteEnv}
          UAT_URL: \${{ vars.UAT_URL }}
          GRAPHYARD_URL: \${{ vars.GRAPHYARD_URL }}
          GRAPHYARD_TOKEN: \${{ secrets.GRAPHYARD_RELEASE_TOKEN }}
      - name: Hand the validated candidate's id to the promotion workflow
        # The promotion this run triggers promotes exactly this candidate, never whichever is newest.
        shell: bash
        run: echo "\${{ needs.candidate.outputs.id }}" > ${candidateArtifact}.txt
      - uses: actions/upload-artifact@v4
        with: { name: ${candidateArtifact}, path: ${candidateArtifact}.txt, retention-days: 7 }
`;
}

export function renderPromotionWorkflow(policy: DeliveryPolicy, options: PipelineOptions = {}) {
  const base = options.base ?? 'main', cli = options.cli ?? pinnedCli();
  return `name: ${promotionWorkflowName}
# Generated by graphyard init from the delivery policy in graphyard.json (docs/onboarding.md).
# Edit graphyard.json, then rerun graphyard init --scan --apply; an edit here is overwritten.
# Production moves only to a candidate whose UAT validation passed on its exact SHA: \`release
# promote\` refuses anything else, whatever triggered this workflow, and production then serves that
# SHA through the ${policy.deploy.adapter} adapter. A failed candidate is fixed forward by a newer one.
on:
  workflow_run:
    workflows: [${quoted(candidateWorkflowName)}]
    types: [completed]
  workflow_dispatch:
    inputs:
      candidate:
        description: Candidate id to promote; latest promotes the newest candidate, which must have passed UAT
        required: false
        default: latest
permissions:
  contents: read
concurrency:
  group: graphyard-promotion
  cancel-in-progress: false
jobs:
  candidate:
    # A candidate run that failed UAT concludes as a failure and promotes nothing.
    if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      actions: read
    outputs:
      id: \${{ steps.resolve.outputs.id }}
    steps:
      - name: Fetch the id of the candidate the triggering run validated
        if: github.event_name == 'workflow_run'
        # A scheduled run that cut no candidate skips UAT and uploads nothing; that run promotes nothing.
        continue-on-error: true
        uses: actions/download-artifact@v4
        with:
          name: ${candidateArtifact}
          run-id: \${{ github.event.workflow_run.id }}
          github-token: \${{ github.token }}
      - name: Resolve the candidate to promote
        id: resolve
        shell: bash
        run: |
          set -euo pipefail
          if [ "$GITHUB_EVENT_NAME" = workflow_dispatch ]; then CANDIDATE="\${CANDIDATE:-latest}";
          elif [ -f ${candidateArtifact}.txt ]; then CANDIDATE="$(cat ${candidateArtifact}.txt)";
          else CANDIDATE=''; echo "The triggering run validated no candidate; nothing to promote."; fi
          echo "id=$CANDIDATE" >> "$GITHUB_OUTPUT"
        env:
          CANDIDATE: \${{ inputs.candidate }}
  promote:
    needs: candidate
    if: needs.candidate.outputs.id != ''
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: write
    environment: production
    steps:
      - uses: actions/checkout@v4
        with: { ref: ${base}, fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - name: Promote the UAT-passed candidate by its exact SHA
        id: promote
        shell: bash
        run: |
          set -euo pipefail
          ${cli} release promote "$CANDIDATE" --base ${base} | tee promote.json
          echo "sha=$(node -p "require('./promote.json').sha")" >> "$GITHUB_OUTPUT"
        env:
          CANDIDATE: \${{ needs.candidate.outputs.id }}
${deployStep(policy, 'production', '${{ steps.promote.outputs.sha }}')}
      - name: Confirm production serves the promoted SHA
        run: ${cli} release verify --base ${base} --url "$PRODUCTION_URL" --wait 1200
        env:
          PRODUCTION_URL: \${{ vars.PRODUCTION_URL }}
`;
}

/** The generated files for a policy: both workflows under the candidate model, none under per-PR. */
export function renderReleasePipeline(policy: DeliveryPolicy, options: PipelineOptions = {}): { path: string; content: string }[] {
  if (policy.mode === 'per-pr') return [];
  // The pin is resolved once here, so the renderers below shell out to git at most once per install.
  options = { ...options, cli: options.cli ?? pinnedCli() };
  return [
    { path: candidateWorkflowFile, content: renderCandidateWorkflow(policy, options) },
    { path: promotionWorkflowFile, content: renderPromotionWorkflow(policy, options) },
  ];
}
