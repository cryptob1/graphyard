import type { ScanInput } from './onboarding.js';

// ---------------------------------------------------------------------------
// Monorepo discovery for init --scan (GY-3202): the workspace packages a pnpm-workspace.yaml or a
// package.json `workspaces` field names, the Railway config files and the package each belongs to,
// and a node application for every package that has a start script. Pure: reads only ScanInput.
// ---------------------------------------------------------------------------

export interface WorkspacePackage { name: string; directory: string; scripts: Record<string, string> }
export interface RailwayFile { app: string | null; file: string }
export interface ProposedNodeApplication { id: string; kind: 'node'; directory: string; build: string | null; start: string }
export interface WorkspaceDiscovery { workspacePackages: WorkspacePackage[]; railway: RailwayFile[]; proposedApplications: ProposedNodeApplication[] }

const json = (raw: string | undefined): any => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

/** The `packages:` globs of a pnpm-workspace.yaml (a block list of plain or quoted strings). */
function pnpmGlobs(raw: string | undefined): string[] {
  if (!raw) return [];
  const globs: string[] = [];
  let inPackages = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (!inPackages || !line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line);
    if (!item) { if (!/^\s/.test(line)) inPackages = false; continue; }
    globs.push(item[1]);
  }
  return globs;
}

const globPattern = (glob: string) => new RegExp(`^${glob.replace(/^\.\//, '').replace(/\/+$/, '')
  .split('/').map(part => part === '**' ? '.*' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('/')}$`);

const basename = (directory: string) => directory.slice(directory.lastIndexOf('/') + 1);
const appId = (directory: string) => basename(directory).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 40) || 'app';

export function discoverWorkspaces(input: ScanInput): WorkspaceDiscovery {
  const root = json(input.contents['package.json']);
  const declared = Array.isArray(root?.workspaces) ? root.workspaces : Array.isArray(root?.workspaces?.packages) ? root.workspaces.packages : [];
  const globs = [...pnpmGlobs(input.contents['pnpm-workspace.yaml']), ...declared].filter((glob): glob is string => typeof glob === 'string');
  const include = globs.filter(glob => !glob.startsWith('!')).map(globPattern), exclude = globs.filter(glob => glob.startsWith('!')).map(glob => globPattern(glob.slice(1)));
  const workspacePackages: WorkspacePackage[] = [];
  for (const file of input.files) {
    const directory = /^(.+)\/package\.json$/.exec(file)?.[1];
    if (!directory || !include.some(pattern => pattern.test(directory)) || exclude.some(pattern => pattern.test(directory))) continue;
    const manifest = json(input.contents[file]) ?? {};
    const scripts = Object.fromEntries(Object.entries(manifest.scripts ?? {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
    workspacePackages.push({ name: typeof manifest.name === 'string' ? manifest.name : basename(directory), directory, scripts });
  }
  const railway: RailwayFile[] = [];
  for (const file of input.files) {
    if (/^railway\.(?:json|toml)$/.test(file)) { railway.push({ app: '.', file }); continue; }
    const named = /^railway-([^/]+)\.json$/.exec(file)?.[1];
    if (named !== undefined) { railway.push({ app: workspacePackages.find(pkg => basename(pkg.directory) === named) ? named : null, file }); continue; }
    const owner = /^(.+)\/railway\.(?:json|toml)$/.exec(file)?.[1];
    if (owner && workspacePackages.some(pkg => pkg.directory === owner)) railway.push({ app: basename(owner), file });
  }
  const proposedApplications = workspacePackages.filter(pkg => pkg.scripts.start).map(pkg => ({
    id: appId(pkg.directory), kind: 'node' as const, directory: pkg.directory,
    build: pkg.scripts.build ? `npm --prefix ${pkg.directory} run build` : null,
    start: `npm --prefix ${pkg.directory} run start`,
  }));
  return { workspacePackages, railway, proposedApplications };
}
