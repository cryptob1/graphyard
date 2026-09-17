import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';

const excluded = new Set(['.git', '.graphyard', 'node_modules', 'dist', 'coverage', 'test-results', 'playwright-report']);
const sensitive = /(^|\/)(\.env(?:\..*)?|\.(?:npmrc|netrc|pypirc)|credentials(?:\.[^/]*)?|id_(?:rsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx))$/i;
const testFile = /(?:^|\/)[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$/;
const configFile = /(?:^|\/)playwright\.config\.[cm]?[jt]s$/;
const maxFiles = 10_000, maxBytes = 20_000_000;
const hash = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function pathWithin(root: string, path: string) { const r = relative(root, path); return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !r.startsWith(sep); }
function safeName(path: string) {
  if (!path || path.length > 500 || /[\x00-\x1f\x7f\\]/.test(path) || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..' || excluded.has(p)) || sensitive.test(path)) throw new Error('Select ordinary relative source files; secrets, generated output and local credentials are excluded');
  return path;
}
/** Read-only discovery. In particular, never import Playwright configuration or run package scripts. */
export async function inspectRunnerRepository(directory: string) {
  const root = await realpath(directory), files: string[] = [], omitted: string[] = [];
  let entriesSeen = 0;
  async function walk(path: string, depth: number) {
    if (depth > 20) throw new Error('Repository exceeds discovery depth; inspect a narrower package directory');
    const location = resolve(root, path);
    const dir = await open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let entries;
    try {
      if (process.platform !== 'linux' || await realpath(`/proc/self/fd/${dir.fd}`) !== location) throw new Error('Discovery path changed or descriptor checks are unavailable');
      entries = await readdir(`/proc/self/fd/${dir.fd}`, { withFileTypes: true });
    } finally { await dir.close(); }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entriesSeen > maxFiles) throw new Error('Repository exceeds discovery file limit; inspect a narrower package directory');
      const name = path ? `${path}/${entry.name}` : entry.name;
      if (excluded.has(entry.name) || sensitive.test(name)) continue;
      if (entry.isSymbolicLink()) { omitted.push(name); continue; }
      if (entry.isDirectory()) await walk(name, depth + 1);
      else if (entry.isFile()) files.push(name);
    }
  }
  await walk('', 0);
  const packages = files.filter(p => /(?:^|\/)package\.json$/.test(p));
  const manifests: { path: string; playwright: boolean; npmLock: boolean }[] = [];
  for (const path of packages) {
    const bytes = await readSource(root, path, 1_000_000);
    let value: any;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`Invalid package JSON: ${path}`); }
    const deps = { ...value?.dependencies, ...value?.devDependencies };
    manifests.push({ path, playwright: typeof deps['@playwright/test'] === 'string', npmLock: files.includes(path.replace(/package\.json$/, 'package-lock.json')) });
  }
  const configs = files.filter(p => configFile.test(p));
  const proposedFiles = files.filter(p => testFile.test(p));
  const blockers: string[] = [];
  if (!manifests.some(p => p.playwright)) blockers.push('No package declares @playwright/test. Add an executable Playwright suite first.');
  if (!manifests.some(p => p.playwright && p.npmLock)) blockers.push('The initial npm adapter requires a package-lock.json beside the Playwright package.');
  if (!configs.length) blockers.push('No Playwright configuration found. Choose an explicit approved configuration.');
  if (!proposedFiles.length) blockers.push('No conventional test files found. Supply explicit test paths if the suite uses another naming convention.');
  return { adapter: 'playwright', status: blockers.length ? 'needs-input' : 'needs-approval', packages: manifests, configs, proposedFiles, omittedSymlinks: omitted, blockers,
    next: ['Review the actual assertions and all helpers/configuration; filenames do not establish test inventory.', 'Snapshot an explicit source-file allowlist, then build and independently approve a digest-pinned executable image.', 'Configure an isolated executor, separately trusted collector and durable private artifact storage before dispatch.'],
    executionEnabled: false, inventoryVerified: false };
}

async function readSource(root: string, path: string, limit: number) {
  safeName(path);
  // Parent symlinks are refused too, even when they point back inside the repository.
  let current = root;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    const s = await lstat(current);
    if (s.isSymbolicLink()) throw new Error('Symlinks are not allowed in approved source snapshots');
  }
  const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > limit) throw new Error('Source must be a bounded regular file');
    // Linux fd identity closes a parent-directory substitution race before bytes are read.
    // Refuse unsupported platforms rather than silently claim the same guarantee there.
    if (process.platform !== 'linux') throw new Error('Source snapshots currently require Linux file-descriptor identity checks');
    const opened = await realpath(`/proc/self/fd/${file.fd}`);
    if (!pathWithin(root, opened) || opened !== current) throw new Error('Source path changed during snapshot');
    const bytes = Buffer.alloc(before.size);
    let count = 0;
    while (count < bytes.length) {
      const r = await file.read(bytes, count, bytes.length - count, count);
      if (!r.bytesRead) throw new Error('Source changed during snapshot');
      count += r.bytesRead;
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Source changed during snapshot');
    return bytes;
  } finally { await file.close(); }
}

/** A reviewable SOURCE snapshot, never an executable-bundle approval or passing evidence. */
export async function snapshotRunnerSources(directory: string, selected: string[]) {
  if (!Array.isArray(selected) || !selected.length || selected.length > 1000 || selected.some(p => typeof p !== 'string') || new Set(selected).size !== selected.length) throw new Error('Select 1–1000 unique source files explicitly');
  const root = await realpath(directory), files: { path: string; digest: string; bytes: string }[] = [];
  let total = 0;
  for (const path of [...selected].sort()) {
    const bytes = await readSource(root, safeName(path), maxBytes - total); total += bytes.length;
    files.push({ path, digest: hash(bytes), bytes: bytes.toString('base64') });
  }
  const manifest = { format: 'graphyard-oracle-source-v1', files };
  return { ...manifest, digest: hash(JSON.stringify(manifest)), totalBytes: total, executable: false, approved: false };
}
