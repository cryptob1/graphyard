import { reportFormats, type ReportFormat } from './report-adapters.js';
import type { SetupProposal } from './onboarding.js';

/**
 * The completion profiles the delivery roadmap names. A profile says what "done" means
 * for a repository, and the readiness checklist says what is still missing before that
 * meaning can be enforced — with the command or setting that supplies it.
 */
export const completionProfiles = ['through-merge', 'preview-validation', 'production-verification'] as const;
export type CompletionProfile = (typeof completionProfiles)[number];
export const profileMeaning: Record<CompletionProfile, string> = {
  'through-merge': 'A verified, authorized merge completes the configured workflow: required checks, independent review, trusted proofs and the merge gate.',
  'preview-validation': 'Through merge, plus a pinned preview candidate exercised by the packaged runner with independently collected behavioural proof.',
  'production-verification': 'Preview validation, plus expected artifacts independently observed running across every required production service.',
};

export type ReadinessStatus = 'ready' | 'missing' | 'unknown';
export interface ReadinessItem {
  id: string; title: string; status: ReadinessStatus;
  /** What was observed. Never a credential value. */
  detail: string;
  /** The direct action that resolves a missing or unknown item; null when nothing is owed. */
  recovery: string | null;
  profiles: CompletionProfile[];
}

/** Everything the checklist judges. Each fact is optional: an absent fact is `unknown`, never `ready`. */
export interface ReadinessFacts {
  repository?: string | null;
  server?: { url: string; reachable: boolean; role?: string; github?: boolean; githubPermissions?: Record<string, string>; failure?: string } | null;
  setup?: { proposal: string | null; appliedAt: string | null; githubApp: { appId: number; slug: string } | null; drift: string[]; unreadable: string[] } | null;
  proposal?: Pick<SetupProposal, 'stack' | 'ci' | 'checks' | 'proofs' | 'deploy' | 'environment' | 'profiles'> | null;
  /** Counts of enabled validation definitions the server holds, by kind and role. */
  validation?: { environments: number; runners: number; collectors: number; builders: number; bundles: number } | null;
}

/**
 * Which report adapter a detected test framework can publish through. A framework with no
 * entry is unsupported for runner-collected proofs: the checklist says so and names the
 * recovery, instead of letting a scan imply coverage the collector would later refuse.
 */
export const frameworkReportFormats: Record<string, { format: ReportFormat; via: string }> = {
  '@playwright/test': { format: 'graphyard-playwright-v1', via: 'the packaged runner image and its built-in reporter' },
  vitest: { format: 'junit-xml-v1', via: 'vitest --reporter=junit' },
  jest: { format: 'junit-xml-v1', via: 'jest-junit' },
  mocha: { format: 'junit-xml-v1', via: 'mocha --reporter xunit or mocha-junit-reporter' },
  pytest: { format: 'junit-xml-v1', via: 'pytest --junitxml' },
  unittest: { format: 'junit-xml-v1', via: 'pytest --junitxml (pytest runs unittest suites)' },
  tox: { format: 'junit-xml-v1', via: 'pytest --junitxml inside the tox environment' },
};

const all: CompletionProfile[] = [...completionProfiles];
/** What an `unknown` item depends on, so it still names the next action. */
const scanFirst = {
  proposal: 'Run `graphyard init --scan` in the repository clone first; this item is judged from the stored proposal',
  server: 'Resolve the control-plane connection first; this item is judged from the server\'s answer',
  github: 'Connect the dedicated GitHub App first; this item is judged from the permissions the server reports',
};
const beyondMerge: CompletionProfile[] = ['preview-validation', 'production-verification'];

export function readinessChecklist(profile: CompletionProfile, facts: ReadinessFacts) {
  if (!completionProfiles.includes(profile)) throw new Error(`Unknown completion profile ${JSON.stringify(profile)}; choose one of ${completionProfiles.join(', ')}`);
  const items: ReadinessItem[] = [];
  const item = (entry: ReadinessItem) => { if (entry.profiles.includes(profile)) items.push(entry); };

  const repository = facts.repository ?? null;
  item({ id: 'repository', title: 'Repository is a GitHub remote', profiles: all,
    status: repository ? 'ready' : facts.repository === undefined ? 'unknown' : 'missing',
    detail: repository ? `origin resolves to ${repository}` : 'origin does not resolve to a GitHub repository',
    recovery: repository ? null : 'Run inside a clone whose origin remote is the GitHub repository Graphyard manages, for example `git remote add origin git@github.com:OWNER/REPO.git`' });

  const server = facts.server ?? null;
  item({ id: 'server', title: 'Control plane reachable with an individual credential', profiles: all,
    status: server === null ? 'unknown' : server.reachable ? 'ready' : 'missing',
    detail: server === null ? 'no connection was attempted' : server.reachable ? `${server.url} answered as role ${server.role ?? 'unknown'}` : `${server.url}: ${server.failure ?? 'not reachable'}`,
    recovery: server?.reachable ? null : 'Set GRAPHYARD_URL and GRAPHYARD_TOKEN to your own role-scoped credential (never a shared one); `graphyard init --url SERVER --token-stdin` stores them for this clone' });
  item({ id: 'credential-role', title: 'Credential can perform setup', profiles: all,
    status: !server?.reachable ? 'unknown' : ['admin', 'coordinator'].includes(server.role ?? '') ? 'ready' : 'missing',
    detail: !server?.reachable ? 'depends on the control plane' : `credential role is ${server.role ?? 'unknown'}`,
    recovery: !server?.reachable ? scanFirst.server : ['admin', 'coordinator'].includes(server?.role ?? '') ? null : 'Setup and proof configuration need an operator (admin) credential; workers cannot revise requirements or register runners. Use the operator entry from GRAPHYARD_PRINCIPALS, and keep it away from implementation agents' });

  const setup = facts.setup ?? null;
  item({ id: 'setup-proposal', title: 'Delivery workflow proposed, reviewed and applied', profiles: all,
    status: setup === null ? 'unknown' : setup.unreadable.length ? 'missing' : setup.appliedAt && !setup.drift.length ? 'ready' : 'missing',
    detail: setup === null ? 'local setup state was not read' : setup.unreadable.length ? `unreadable: ${setup.unreadable.join(', ')}` : setup.appliedAt ? (setup.drift.length ? `applied ${setup.appliedAt}; drift: ${setup.drift.join('; ')}` : `applied ${setup.appliedAt}`) : setup.proposal ? `${setup.proposal} is stored but not applied` : 'no proposal stored',
    recovery: setup === null ? 'Run `graphyard doctor` inside the repository clone' : setup.unreadable.length ? 'Delete or repair the unreadable file under .graphyard/, then rerun `graphyard init --scan`' : setup.appliedAt && !setup.drift.length ? null : setup.proposal ? (setup.drift.length ? 'Rerun `graphyard init --scan`, review the refreshed .graphyard/setup-proposal.json, then `graphyard init --scan --apply --url SERVER_URL`' : 'Review .graphyard/setup-proposal.json, then run `graphyard init --scan --apply --url SERVER_URL`') : 'Run `graphyard init --scan`, review .graphyard/setup-proposal.json, then apply it with `graphyard init --scan --apply --url SERVER_URL`' });

  const github = server?.reachable ? !!server.github : null;
  item({ id: 'github-app', title: 'Dedicated GitHub App connected', profiles: all,
    status: github === null ? (setup?.githubApp ? 'unknown' : 'missing') : github ? 'ready' : 'missing',
    detail: github ? 'the control plane observes the repository through its App' : setup?.githubApp ? `App ${setup.githubApp.slug} (${setup.githubApp.appId}) is registered locally but the server does not report it` : 'no App is registered',
    recovery: github ? null : setup?.githubApp ? 'Set GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_PRIVATE_KEY (or _FILE) and GITHUB_WEBHOOK_SECRET on the deployment from .graphyard/github-app.json, then redeploy; merge gates stay closed until the server reports the App' : 'Run `graphyard github-setup https://YOUR-GRAPHYARD` (or `init --scan --apply`) to register the App through the manifest flow, install it on the repository, then configure the deployment variables' });
  const permissions = server?.githubPermissions ?? {};
  const needed: [string, string[]][] = [['pull_requests', ['write']], ['checks', ['write']], ['contents', ['write']], ['issues', ['read', 'write']]];
  const lacking = github ? needed.filter(([scope, accepted]) => !accepted.includes(permissions[scope] ?? '')).map(([scope]) => scope) : [];
  item({ id: 'github-permissions', title: 'App permissions cover checks, reviews and the merge queue', profiles: all,
    status: !github ? 'unknown' : lacking.length ? 'missing' : 'ready',
    detail: !github ? 'depends on the GitHub App' : lacking.length ? `insufficient: ${lacking.join(', ')}` : 'pull_requests, checks, contents and issues are granted',
    recovery: !github ? scanFirst.github : !lacking.length ? null : `Grant ${lacking.join(', ')} to the App under GitHub → Settings → Developer settings → GitHub Apps → Permissions, accept the new permissions on the installation, then rerun \`graphyard doctor\`` });

  const proposal = facts.proposal ?? null;
  item({ id: 'required-checks', title: 'Required CI checks discovered', profiles: all,
    status: proposal === null ? 'unknown' : proposal.checks.length ? 'ready' : 'missing',
    detail: proposal === null ? 'no proposal to read' : proposal.checks.length ? `checks: ${proposal.checks.join(', ')} (${proposal.ci.system})` : 'no CI checks were discovered',
    recovery: proposal === null ? scanFirst.proposal : proposal.checks.length ? null : 'Add a GitHub Actions workflow that runs on pull_request with the test and static-analysis jobs, or declare the check names by hand in the proposal before applying it' });

  const frameworks = proposal?.stack.frameworks ?? [];
  const e2e = frameworks.filter(f => f === '@playwright/test' || f === 'cypress');
  const unsupported = frameworks.filter(f => !frameworkReportFormats[f]);
  item({ id: 'test-formats', title: 'Detected test frameworks have a supported report format', profiles: all,
    status: proposal === null ? 'unknown' : !frameworks.length ? 'missing' : unsupported.length ? 'missing' : 'ready',
    detail: proposal === null ? 'no proposal to read' : !frameworks.length ? 'no test framework was detected' : frameworks.map(f => frameworkReportFormats[f] ? `${f} → ${frameworkReportFormats[f].format} via ${frameworkReportFormats[f].via}` : `${f} → unsupported`).join('; '),
    recovery: proposal === null ? scanFirst.proposal : !frameworks.length ? 'Add an executable test suite first; a scan proposes proofs only for tests that exist, and the runner never invents coverage' : unsupported.length ? `${unsupported.join(', ')}: no adapter accepts this framework's reports. Emit JUnit XML from it (most runners can) so the junit-xml-v1 adapter applies, or use Playwright for the end-to-end path. Supported formats: ${reportFormats.join(', ')}; see \`graphyard runner adapters\`` : null });
  item({ id: 'e2e-suite', title: 'Playwright suite for the packaged runner', profiles: beyondMerge,
    status: proposal === null ? 'unknown' : e2e.includes('@playwright/test') ? 'ready' : 'missing',
    detail: proposal === null ? 'no proposal to read' : e2e.includes('@playwright/test') ? '@playwright/test is declared' : e2e.length ? `${e2e.join(', ')} is not a supported end-to-end runner` : 'no end-to-end framework was detected',
    recovery: proposal === null ? scanFirst.proposal : e2e.includes('@playwright/test') ? null : 'The packaged runner executes an approved Playwright bundle. Add a Playwright suite (with package-lock.json beside it), then `graphyard runner inspect` to propose its inputs' });

  const workers = proposal?.profiles.workers.length ?? null;
  item({ id: 'worker-profiles', title: 'At least one worker profile with its own credential', profiles: all,
    status: workers === null ? 'unknown' : workers > 0 ? 'ready' : 'missing',
    detail: workers === null ? 'no proposal to read' : `${workers} worker profile(s) proposed`,
    recovery: workers === null ? scanFirst.proposal : workers > 0 ? null : 'Install an agent CLI (claude, codex, gemini, opencode, ...) on the machine that runs workers, then rerun `graphyard init --scan --apply`; a machine without a runtime gets no worker credential' });
  item({ id: 'reviewer', title: 'Independent review provider selected', profiles: all,
    status: proposal === null ? 'unknown' : proposal.profiles.reviewer.provider ? 'ready' : 'missing',
    detail: proposal === null ? 'no proposal to read' : `review provider: ${proposal.profiles.reviewer.provider}`,
    recovery: proposal === null ? scanFirst.proposal : proposal.profiles.reviewer.provider ? null : 'Choose a review provider with `graphyard reviewpolicy GY-N github|codex|agent POLICY_REVISION REASON`' });

  const validation = facts.validation ?? null;
  const runnerPath: [string, keyof NonNullable<ReadinessFacts['validation']>, string, string][] = [
    ['validation-environment', 'environments', 'Immutable preview environment defined', 'Define the preview environment as an operator: `graphyard validation define environment.json` with `immutable: true`, its HTTPS URL, instance and protected resources'],
    ['runner-registration', 'runners', 'Runner registration pins host, attestor key and network', 'Register the runner (worker principal) with `graphyard validation define runner.json`: a local unix:// Docker socket, the attestor\'s Ed25519 public key and a dedicated isolated network; see docs/runner-setup.md'],
    ['collector-registration', 'collectors', 'Separately trusted collector registered', 'Register the collector under its own producer principal, scoped to the e2e proof, with `graphyard validation define collector.json`'],
    ['builder-registration', 'builders', 'Build producer registered for candidate provenance', 'Register the build attestor (producer principal) with `graphyard validation define builder.json`; candidates without trusted provenance cannot be validated'],
    ['approved-bundle', 'bundles', 'Executable oracle bundle approved by digest', 'Build the bundle, measure it with `graphyard runner bundle-digest DIR`, and pin digest, runnerImageDigest and reportFormat against the scenario revision with `graphyard validation define bundle.json`'],
  ];
  for (const [id, key, title, recovery] of runnerPath) {
    const count = validation?.[key] ?? null;
    item({ id, title, profiles: beyondMerge,
      status: count === null ? 'unknown' : count > 0 ? 'ready' : 'missing',
      detail: count === null ? 'validation definitions were not read' : `${count} enabled`,
      recovery: count === null ? 'Read definitions with an operator credential: `graphyard validation definitions`' : count > 0 ? null : recovery });
  }

  const deploy = proposal?.deploy ?? null;
  item({ id: 'deploy-target', title: 'Deployment target detected with SHA verification', profiles: beyondMerge,
    status: deploy === null ? 'unknown' : deploy.target === 'none' ? 'missing' : 'ready',
    detail: deploy === null ? 'no proposal to read' : `${deploy.target}: ${deploy.verification}`,
    recovery: deploy === null ? scanFirst.proposal : deploy.target !== 'none' ? null : 'Add a deploy configuration (railway.json, vercel.json, fly.toml, a Dockerfile, or GitHub Pages) so candidates have a target whose commit identity can be verified' });
  item({ id: 'production-observation', title: 'Independent production observation', profiles: ['production-verification'],
    status: 'missing',
    detail: 'release membership and independently measured runtime identity across required services (roadmap increment D3) are not shipped; a green merge or deploy job is not production proof',
    recovery: 'Until D3 ships, record production verification as an explicit manual proof observed by an operator; do not mark the profile complete from deployment logs' });

  const missing = items.filter(i => i.status === 'missing'), unknown = items.filter(i => i.status === 'unknown');
  return { profile, meaning: profileMeaning[profile], ready: !missing.length && !unknown.length, items,
    summary: { ready: items.length - missing.length - unknown.length, missing: missing.length, unknown: unknown.length },
    next: missing[0]?.recovery ?? unknown[0]?.recovery ?? 'Every item is ready: submit a real PR and inspect each gate; configured is not proof of enforcement' };
}

/** Count the current revision of each validation definition the server lists. */
export function summarizeDefinitions(definitions: { kind: string; id: string; revision: number; role?: string; enabled?: boolean }[]): NonNullable<ReadinessFacts['validation']> {
  const latest = new Map<string, { kind: string; role?: string; enabled?: boolean; revision: number }>();
  for (const d of definitions) { const key = `${d.kind}/${d.id}`; if ((latest.get(key)?.revision ?? 0) < d.revision) latest.set(key, d); }
  const counts = { environments: 0, runners: 0, collectors: 0, builders: 0, bundles: 0 };
  for (const d of latest.values()) {
    if (d.kind === 'environment') counts.environments++;
    else if (d.kind === 'bundle') counts.bundles++;
    else if (d.kind === 'registration' && d.enabled) { if (d.role === 'runner') counts.runners++; else if (d.role === 'collector') counts.collectors++; else if (d.role === 'builder') counts.builders++; }
  }
  return counts;
}
