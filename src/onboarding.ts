import { execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

export function repositoryFromRemote(remote: string) {
  const value = remote.trim();
  let path = /^git@github\.com:(.+)$/i.exec(value)?.[1];
  if (!path) {
    try {
      const url = new URL(value); const host = url.hostname.toLowerCase();
      const https = url.protocol === 'https:' && host === 'github.com' && !url.port;
      const ssh = url.protocol === 'ssh:' && url.username === 'git' && !url.password &&
        (host === 'github.com' && ['', '22'].includes(url.port) || host === 'ssh.github.com' && url.port === '443');
      if ((!https && !ssh) || url.search || url.hash) return null;
      path = url.pathname.slice(1);
    } catch { return null; }
  }
  return /^([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(path)?.[1] ?? null;
}
export function assertRepository(repository: string | null, configured: unknown) {
  if (typeof configured !== 'string' || !configured) return;
  if (!repository) throw new Error('Cannot verify this checkout against the configured server repository; configure its GitHub origin first');
  if (repository.toLowerCase() !== configured.toLowerCase()) throw new Error('This checkout and Graphyard server are configured for different repositories');
}
export async function discover(root: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let repository: string | null = null;
  try { repository = repositoryFromRemote(git('remote', 'get-url', 'origin')); } catch { /* no remote */ }
  let pkg: any = {};
  try { pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')); } catch { /* non-Node repository */ }
  let workflows: string[] = [];
  try { workflows = (await readdir(resolve(root, '.github/workflows'))).filter(f => /\.ya?ml$/.test(f)); } catch { /* no CI */ }
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  const frameworks = ['vitest', 'jest', '@playwright/test', 'cypress'].filter(name => dependencies[name]);
  return { repository, scripts: Object.keys(pkg.scripts ?? {}), frameworks, workflows,
    proposedChecks: ['test', 'typecheck'].filter(name => pkg.scripts?.[name]),
    lifecycle: ['ready', 'build', 'review', 'test', 'acceptance', 'merge', 'done'] };
}
export async function saveDiscovery(root: string) {
  const discovery = await discover(root);
  const directory = await localDirectory(root);
  await writeFile(resolve(directory, 'project.json'), JSON.stringify(discovery, null, 2), { mode: 0o600 });
  return discovery;
}
export async function localDirectory(root: string) {
  const tracked = execFileSync('git', ['ls-files', '--', '.graphyard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (tracked.trim()) throw new Error('.graphyard contains tracked files; untrack and inspect them before saving credentials');
  const ignorePath = resolve(root, '.gitignore');
  let ignore = ''; try { ignore = await readFile(ignorePath, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const ignored = (path: string) => {
    try { execFileSync('git', ['check-ignore', '--quiet', '--', path], { cwd: root, stdio: 'ignore' }); return true; }
    catch (error: any) { if (error.status === 1) return false; throw new Error('Cannot verify Git ignores local Graphyard credentials'); }
  };
  // An earlier matching line can be overridden by later negations. Ignore the
  // directory itself so nested rules cannot re-include credentials or temp files.
  const directory = resolve(root, '.graphyard'); await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!ignored('.graphyard')) await writeFile(ignorePath, `${ignore}${ignore.endsWith('\n') || !ignore ? '' : '\n'}.graphyard/\n`);
  if (!ignored('.graphyard') || !ignored('.graphyard/connection.json')) throw new Error('Local Graphyard credentials must be ignored by Git before saving');
  return directory;
}

// --- Drop-in setup: read-only repository scan ---------------------------------

export interface ScanInput { files: string[]; contents: Record<string, string> }

const scanExcluded = new Set(['.git', '.graphyard', 'node_modules', 'dist', 'build', 'coverage', 'vendor', 'venv', '.venv', '__pycache__', 'test-results', 'playwright-report']);
const scanInteresting: RegExp[] = [
  /^package\.json$/, /^pyproject\.toml$/, /^requirements(?:-dev)?\.txt$/, /^setup\.(?:py|cfg)$/, /^Pipfile$/, /^tox\.ini$/,
  /^Dockerfile(?:\.[^/]*)?$/, /^(?:docker-)?compose\.ya?ml$/, /^railway\.(?:json|toml)$/, /^vercel\.json$/, /^fly\.toml$/, /^netlify\.toml$/,
  /^\.nojekyll$/, /^CNAME$/, /^index\.html$/, /^\.env\.example$/, /^pytest\.ini$/, /^conftest\.py$/,
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
];
const scanLimits = { files: 5000, depth: 6, bytes: 262_144 };

/** Read-only bounded walk that keeps only paths and whitelisted manifest/config text. Never executes repository code. */
export async function collectScanInput(root: string): Promise<ScanInput> {
  const files: string[] = [], contents: Record<string, string> = {};
  let seen = 0;
  const walk = async (prefix: string, depth: number): Promise<void> => {
    if (depth > scanLimits.depth) return;
    const entries = await readdir(resolve(root, prefix || '.'), { withFileTypes: true }).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++seen > scanLimits.files) throw new Error('Repository exceeds the scan file limit; inspect a narrower checkout');
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || scanExcluded.has(entry.name)) continue;
      if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
      if (!entry.isFile()) continue;
      files.push(path);
      if (scanInteresting.some(pattern => pattern.test(path))) {
        const bytes = await readFile(resolve(root, path)).catch((error: any) => { if (error.code === 'ENOENT') return null; throw error; });
        if (bytes && bytes.length <= scanLimits.bytes) contents[path] = bytes.toString('utf8');
      }
    }
  };
  await walk('', 0);
  return { files, contents };
}

const parseJson = (input: ScanInput, path: string): any | null => {
  const raw = input.contents[path];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

const testFileLayout = (files: string[]) => {
  const layout: string[] = [];
  for (const directory of ['tests', 'test', 'spec', 'e2e']) if (files.some(f => f.startsWith(`${directory}/`))) layout.push(`${directory}/`);
  if (files.some(f => /(?:^|\/)[^/]+\.test\.[cm]?[jt]sx?$/.test(f) && !layout.some(d => f.startsWith(d)))) layout.push('**/*.test.*');
  if (files.some(f => /(?:^|\/)[^/]+\.spec\.[cm]?[jt]sx?$/.test(f) && !layout.some(d => f.startsWith(d)))) layout.push('**/*.spec.*');
  if (files.some(f => /(?:^|\/)test_[^/]+\.py$/.test(f))) layout.push('**/test_*.py');
  if (files.some(f => /(?:^|\/)[^/]+_test\.py$/.test(f))) layout.push('**/*_test.py');
  return layout;
};

export interface StackDetection {
  name: 'node' | 'python' | 'static' | 'unknown';
  evidence: string[];
  frameworks: string[];
  testLayout: string[];
  commands: { purpose: 'test' | 'static-analysis' | 'build'; command: string; check: string }[];
}

export function detectStack(input: ScanInput): StackDetection {
  const pkg = parseJson(input, 'package.json');
  if (pkg && typeof pkg === 'object') {
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    const frameworks = ['vitest', 'jest', '@playwright/test', 'cypress', 'mocha'].filter(name => dependencies[name]);
    const commands = (['test', 'typecheck', 'lint', 'build'] as const)
      .filter(script => typeof scripts[script] === 'string' && scripts[script])
      .map(script => ({ purpose: (script === 'build' ? 'build' : script === 'test' ? 'test' : 'static-analysis') as 'test' | 'build' | 'static-analysis', command: `npm run ${script}`, check: script }));
    return { name: 'node', evidence: ['package.json'], frameworks, testLayout: testFileLayout(input.files), commands };
  }
  const pythonMarker = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'setup.py', 'setup.cfg', 'Pipfile'].find(name => input.files.includes(name));
  if (pythonMarker) {
    const manifest = input.contents[pythonMarker] ?? '';
    const frameworks = ['pytest', 'tox', 'unittest'].filter(name => manifest.includes(name) || input.files.includes(name === 'pytest' ? 'pytest.ini' : `${name}.ini`));
    const commands = frameworks.includes('pytest') ? [{ purpose: 'test' as const, command: 'python -m pytest -q', check: 'pytest' }] : [];
    return { name: 'python', evidence: [pythonMarker], frameworks, testLayout: testFileLayout(input.files), commands };
  }
  if (input.files.includes('index.html') || input.files.includes('.nojekyll') || input.files.includes('CNAME'))
    return { name: 'static', evidence: input.files.includes('index.html') ? ['index.html'] : ['.nojekyll'], frameworks: [], testLayout: [], commands: [] };
  return { name: 'unknown', evidence: [], frameworks: [], testLayout: [], commands: [] };
}

/** Required-check candidates from workflow job ids and their explicit `name:` overrides. */
export function workflowCheckNames(input: ScanInput, options: { onlyPullRequest?: boolean } = {}): string[] {
  const names: string[] = [];
  const record = (name: string) => { if (!names.includes(name)) names.push(name); };
  const triggersPullRequest = (raw: string) => {
    const inlineList = /^on:\s*\[([^\]]*)\]/m.exec(raw);
    if (inlineList) return /\bpull_request\b/.test(inlineList[1]);
    const inline = /^on:\s+(\S.*)$/m.exec(raw);
    if (inline) return /\bpull_request\b/.test(inline[1]);
    let inOn = false;
    for (const line of raw.split('\n')) {
      if (/^\S/.test(line)) inOn = line.startsWith('on:');
      else if (inOn && /^  pull_request(?:\s*:|$)/.test(line)) return true;
    }
    return false;
  };
  for (const [path, raw] of Object.entries(input.contents)) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) continue;
    if (options.onlyPullRequest && !triggersPullRequest(raw)) continue;
    let inJobs = false, current: string | null = null, currentLabeled = false;
    for (const line of raw.split('\n')) {
      if (/^\S/.test(line)) { inJobs = line.startsWith('jobs:'); current = null; continue; }
      if (!inJobs) continue;
      const job = /^  ([\w-]+):\s*(?:#.*)?$/.exec(line);
      if (job) { current = job[1]; currentLabeled = false; record(current); continue; }
      const label = /^    name:\s*(.+?)\s*$/.exec(line);
      if (label && current && !currentLabeled) {
        currentLabeled = true;
        const cleaned = label[1].replace(/^['"]|['"]$/g, '');
        if (cleaned && cleaned !== current) { const at = names.indexOf(current); names.splice(at, 1); record(cleaned); current = cleaned; }
      }
    }
  }
  return names.slice(0, 10);
}

export type DeployTarget = 'railway' | 'vercel' | 'fly' | 'github-pages' | 'container-registry' | 'none';

export interface DeployDetection { target: DeployTarget; evidence: string[]; verification: string; proofName: string }

const deployVerification: Record<Exclude<DeployTarget, 'none'>, string> = {
  railway: 'Deploy the candidate to an isolated Railway environment and verify the reported RAILWAY_GIT_COMMIT_SHA (or an equivalent version endpoint) equals the candidate SHA before recording deploy evidence.',
  vercel: 'Inspect the Vercel deployment for the candidate (VERCEL_GIT_COMMIT_SHA in its build metadata or the deployments API) and compare it with the candidate SHA before recording deploy evidence.',
  fly: 'Run fly status (or the releases API) for the application and confirm the active release was built from the candidate SHA before recording deploy evidence.',
  'github-pages': 'Publish a versioned artifact (for example version.json containing the commit SHA) during the Pages build, then fetch it from the deployed site and compare it with the candidate SHA before recording deploy evidence.',
  'container-registry': 'Tag the candidate image with its SHA (and org.opencontainers.image.revision), resolve the pushed digest in the registry, and verify the deployed runtime reports that digest before recording deploy evidence.',
};

export function detectDeploy(input: ScanInput, stack: StackDetection): DeployDetection {
  const find = (name: string) => input.files.find(file => file === name || file.startsWith(`${name}.`));
  const platform = (['railway', 'vercel', 'fly'] as const).find(name => find(name));
  if (platform) return { target: platform, evidence: [find(platform)!], verification: deployVerification[platform], proofName: 'manual:deployed-sha' };
  const containerFiles = input.files.some(file => /^Dockerfile(?:\.[^/]*)?$/.test(file)) || input.files.some(file => /^(?:docker-)?compose\.ya?ml$/.test(file));
  const pages = input.files.includes('.nojekyll') || input.files.includes('CNAME') || (stack.name === 'static' && !containerFiles);
  if (pages) return { target: 'github-pages', evidence: input.files.includes('.nojekyll') ? ['.nojekyll'] : input.files.includes('CNAME') ? ['CNAME'] : ['static site without a server runtime'], verification: deployVerification['github-pages'], proofName: 'manual:deployed-sha' };
  if (containerFiles) return { target: 'container-registry', evidence: [input.files.find(file => /^Dockerfile/.test(file)) ?? 'compose.yaml'], verification: deployVerification['container-registry'], proofName: 'manual:deployed-sha' };
  return { target: 'none', evidence: [], verification: 'No deploy target was detected. Record deploy verification as an explicit manual proof or add a target before treating a merged change as deployed.', proofName: 'manual:deployed-sha' };
}

const databaseHint = /postgres|mysql|mongo|redis|cockroach|mariadb|mssql|sqlserver/i;

/** Shared backing data detected in manifests, compose services, or environment examples. */
export function hasSharedDatabase(input: ScanInput): { detected: boolean; evidence: string[] } {
  const evidence: string[] = [];
  const pkg = parseJson(input, 'package.json');
  const dependencies = { ...pkg?.dependencies, ...pkg?.devDependencies };
  for (const [name] of Object.entries(dependencies)) if (databaseHint.test(name)) evidence.push(`package.json dependency ${name}`);
  for (const manifest of ['requirements.txt', 'requirements-dev.txt']) for (const line of (input.contents[manifest] ?? '').split('\n'))
    if (databaseHint.test(line) && line.trim() && !line.trim().startsWith('#')) { evidence.push(`${manifest} requirement`); break; }
  for (const key of Object.keys(input.contents)) {
    if (/^(?:docker-)?compose\.ya?ml$/.test(key) && databaseHint.test(input.contents[key])) { evidence.push(`${key} service image`); continue; }
    if (key === '.env.example' && /(?:DATABASE|REDIS|POSTGRES|MYSQL|MONGO)[_A-Z]*URL/i.test(input.contents[key]) && databaseHint.test(input.contents[key])) evidence.push('.env.example connection URL');
  }
  return { detected: evidence.length > 0, evidence: [...new Set(evidence)].slice(0, 5) };
}

export type EnvironmentTopology = 'ephemeral' | 'pooled' | 'partial';

/**
 * Candidate-bound-environment invariant: ephemeral where the stack allows,
 * pooled or partial with explicit data isolation where it does not.
 */
export function environmentTopology(deploy: DeployDetection, database: { detected: boolean; evidence: string[] }): { topology: EnvironmentTopology; declaration: string } {
  if (deploy.target === 'none') return { topology: 'partial', declaration: 'No deploy target was detected, so only CI-level isolation exists today. The operator must add a deploy target or accept that environment verification is partial, and any shared backing service requires declared data isolation between candidates.' };
  if (deploy.target === 'container-registry' && database.detected) return { topology: 'pooled', declaration: `Candidates deploy as isolated containers, but a shared backing datastore was detected (${database.evidence.join(', ')}). Environments are pooled: every candidate must receive isolated data — a per-candidate schema or database seeded from structure only — so concurrent candidates cannot observe each other's state.` };
  return { topology: 'ephemeral', declaration: deploy.target === 'github-pages'
    ? 'Each candidate deploys to a disposable static target created from its own commit and discarded after review; nothing persists between candidates.'
    : `Each candidate deploys to its own ${deploy.target} environment built from its commit and destroyed after review. Any backing datastore must be a per-candidate copy seeded from structure${database.detected ? ` (a shared ${database.evidence.join(', ')} was detected and must not be reused across candidates)` : ''}, never shared live state.` };
}

export const agentRuntimes = ['claude', 'codex', 'gemini', 'opencode', 'copilot', 'cursor', 'qwen', 'amp', 'grok', 'kimi', 'kiro', 'droid', 'cline', 'devin', 'hermes', 'kilo', 'qodercli', 'maki', 'agy', 'omp', 'mastracode', 'pi'] as const;
export type AgentRuntime = (typeof agentRuntimes)[number];

/** Runtimes present on this machine, probed without executing anything. */
export function availableRuntimes(searchPath: string | undefined = process.env.PATH, check: (candidate: string) => boolean = candidate => {
  try { accessSync(candidate, fsConstants.X_OK); return true; } catch { return false; }
}) {
  const found: string[] = [];
  for (const directory of (searchPath ?? '').split(':')) {
    if (!directory || directory === '.') continue;
    for (const kind of agentRuntimes) if (!found.includes(kind) && check(resolve(directory, kind))) found.push(kind);
  }
  return found;
}

export const proposedWorkerProfileSchema = z.object({
  name: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  principal: z.string().trim().min(1).max(200),
  agentName: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  mode: z.literal('launch'),
  kind: z.enum(agentRuntimes),
  credentialFile: z.string().startsWith('/'),
  agentArgs: z.array(z.string().max(1000)).max(30),
  environment: z.record(z.string(), z.string()),
}).strict();

const proofPrefix = (purpose: 'test' | 'static-analysis' | 'build') => purpose === 'test' ? 'integration' : 'unit';
const proofName = (purpose: 'test' | 'static-analysis' | 'build', check: string) =>
  `${proofPrefix(purpose)}:${check.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'check'}`;

export const setupProposalSchema = z.object({
  version: z.literal(1),
  repository: z.string().min(1),
  server: z.string().nullable(),
  stack: z.object({ name: z.enum(['node', 'python', 'static', 'unknown']), evidence: z.array(z.string()), frameworks: z.array(z.string()), testLayout: z.array(z.string()) }).strict(),
  ci: z.object({ system: z.string(), jobs: z.array(z.string()).max(12) }).strict(),
  checks: z.array(z.string()).max(12),
  commands: z.array(z.object({ purpose: z.enum(['test', 'static-analysis', 'build']), command: z.string(), check: z.string() }).strict()).max(12),
  proofs: z.array(z.object({ name: z.string(), command: z.string().nullable(), check: z.string().nullable() }).strict()).max(12),
  deploy: z.object({ target: z.enum(['railway', 'vercel', 'fly', 'github-pages', 'container-registry', 'none']), verification: z.string(), proofName: z.string(), evidence: z.array(z.string()) }).strict(),
  environment: z.object({ topology: z.enum(['ephemeral', 'pooled', 'partial']), declaration: z.string() }).strict(),
  policy: z.object({ checks: z.array(z.string()), review: z.boolean(), reviewProvider: z.string(), evidenceExpectations: z.string() }).strict(),
  profiles: z.object({
    workers: z.array(proposedWorkerProfileSchema).max(2),
    reviewer: z.object({ provider: z.string(), note: z.string() }).strict(),
  }).strict(),
  githubApp: z.object({ name: z.string(), repository: z.string(), flow: z.string() }).strict().nullable(),
}).strict();
export type SetupProposal = z.infer<typeof setupProposalSchema>;

export function buildProposal(input: ScanInput, options: { repository?: string | null; server?: string | null; runtimes?: string[]; credentialDirectory?: string } = {}): SetupProposal {
  const stack = detectStack(input);
  const deploy = detectDeploy(input, stack);
  const database = hasSharedDatabase(input);
  const topology = environmentTopology(deploy, database);
  const jobs = workflowCheckNames(input), prJobs = workflowCheckNames(input, { onlyPullRequest: true });
  const ci = { system: Object.keys(input.contents).some(path => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) ? 'github-actions' : 'none', jobs };
  const fallbackJobs = prJobs.length ? prJobs : jobs;
  const checks = [...new Set([...stack.commands.map(command => command.check), ...(stack.commands.length ? [] : fallbackJobs)])].slice(0, 12);
  const proofs = [
    ...stack.commands.filter(command => command.purpose !== 'build').map(command => ({ name: proofName(command.purpose, command.check), command: command.command, check: command.check })),
    { name: deploy.proofName, command: null, check: null },
  ];
  const repository = options.repository ?? 'unknown';
  const repoSlug = repository.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'repository';
  const runtimes = (options.runtimes ?? []).filter(kind => (agentRuntimes as readonly string[]).includes(kind));
  const credentialDirectory = options.credentialDirectory ?? resolve(homedir(), '.config/graphyard/workers');
  const workers = runtimes.slice(0, 2).map((kind, index) => proposedWorkerProfileSchema.parse({
    name: `${kind}-primary`, principal: `worker-${index + 1}`, agentName: `${repoSlug}-${kind}-${index + 1}`.slice(0, 100),
    mode: 'launch', kind, credentialFile: resolve(credentialDirectory, `${kind}-primary.token`), agentArgs: [], environment: {},
  }));
  return setupProposalSchema.parse({
    version: 1, repository, server: options.server ?? null,
    stack: { name: stack.name, evidence: stack.evidence, frameworks: stack.frameworks, testLayout: stack.testLayout },
    ci, checks, commands: stack.commands,
    proofs,
    deploy,
    environment: topology,
    policy: { checks, review: true, reviewProvider: 'github',
      evidenceExpectations: 'Automated proofs are submitted only by a trusted producer credential in protected CI, for the exact candidate SHA with executed > 0 and skipped = 0. Manual proofs are inspected and submitted by a separate operator session. Implementation workers never hold producer or admin credentials.' },
    profiles: { workers, reviewer: { provider: 'github', note: 'Reviews are GitHub approvals on the pull request from a reviewer independent of the author; a hosted Codex reviewer can be selected later with reviewpolicy.' } },
    githubApp: options.repository && /^[\w.-]+\/[\w.-]+$/.test(options.repository) ? { name: `Graphyard ${repository.replace('/', '-')}`, repository, flow: 'github-setup' } : null,
  });
}

/** Stable JSON with recursively sorted keys, so digests do not depend on property order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
