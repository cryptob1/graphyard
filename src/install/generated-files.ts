import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseGeneratedFiles } from '../generated-files.js';
import { parseGeneratedManifest } from '../sync.js';

/**
 * The generated-files deployment variable every installer sets beside GRAPHYARD_PRINCIPALS, next
 * to the capacity limits: the comma-separated exact repository-relative paths the managed
 * repository's generated-file manifest declares, derived from that manifest by every installer.
 */
export const generatedFilesVariable = 'GRAPHYARD_GENERATED_FILES' as const;

/** The repository script that declares the manifest; a repository without it declares none. */
export const generatedManifestScript = 'scripts/check-docs.mjs';

/** What an installer writes beside GRAPHYARD_PRINCIPALS for one repository's manifest. */
export interface GeneratedFilesAssignment { variable: typeof generatedFilesVariable; files: string[]; value: string; line: string }

// The manifest is repository code, so it runs with a bound: a script that hangs must not hang
// `master status` or an install. A killed run has no status and is reported like any other failure.
const runManifestScript = (root: string, args: string[]) =>
  spawnSync(process.execPath, [generatedManifestScript, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });

/**
 * A manifest that declares an empty set is a declaration, not a failure: the repository renders
 * no generated page, so the deployment exempts nothing and the variable stays unset.
 */
const declaresNothing = (output: string) => {
  try { const parsed = JSON.parse(output); return Array.isArray(parsed?.generated) && parsed.generated.length === 0; }
  catch { return false; }
};

/** The assignment for a parsed declaration, or null when it declares no generated files. */
const assignment = (files: readonly string[]): GeneratedFilesAssignment | null => {
  if (!files.length) return null;
  // The server refuses an unparseable value at start-up (src/generated-files.ts), so the
  // derivation is held to the same contract here: the documented command yields a value the
  // deployment accepts, never one it would crash-loop on.
  const declared = parseGeneratedFiles(files.join(','));
  return { variable: generatedFilesVariable, files: declared, value: declared.join(','), line: `${generatedFilesVariable}=${declared.join(',')}` };
};

/**
 * The paths a `--list` line declares, or null when the line is not one. A script that predates
 * `--list` ignores the flag and still exits 0 — the real predecessor runs its full docs check
 * and prints a sentence — so the exit code never proves the flag ran, and an entry with
 * whitespace inside is not a repository-relative path, which is what separates that prose
 * from a real list.
 */
const listedPaths = (value: string): { files: string[] | null; refusal: string | null } => {
  const entries = value.split(',').map(entry => entry.trim());
  if (!entries.length || !entries.every(entry => entry && !/\s/.test(entry))) return { files: null, refusal: null };
  try { return { files: parseGeneratedFiles(entries.join(',')), refusal: null }; }
  catch (error: any) { return { files: null, refusal: error.message }; }
};

/**
 * Derive the generated-files deployment variable from the managed repository's manifest. The
 * manifest JSON (`node scripts/check-docs.mjs --manifest`) is the declaration of record and the
 * form every script has printed the longest, so it wins whenever it parses; `--list` — the
 * comma-separated form the server parses — serves a script that predates `--manifest`, and only
 * counts when its output parses as exact repository-relative paths. Returns null when the
 * repository declares no manifest, and refuses with a clear message when a declared manifest
 * fails or prints a value the server would not accept, so an installer never stays silent about
 * a declaration it could not read.
 */
export function generatedFilesAssignment(root: string): GeneratedFilesAssignment | null {
  if (!existsSync(resolve(root, generatedManifestScript))) return null;
  const listedRun = runManifestScript(root, ['--list']);
  const listedValue = listedRun.status === 0 ? listedRun.stdout.trim() : null;
  const listed = listedValue ? listedPaths(listedValue) : { files: null, refusal: null };
  const manifest = runManifestScript(root, ['--manifest']);
  if (manifest.status === 0) {
    const parsed = parseGeneratedManifest(manifest.stdout);
    if (parsed) return assignment(parsed.files);
    if (declaresNothing(manifest.stdout)) return null;
  }
  if (listed.files) return assignment(listed.files);
  if (manifest.status !== 0)
    throw new Error(`The generated-file manifest failed (${generatedManifestScript} exited ${manifest.status ?? 'unknown'} for --manifest and ${listedRun.status ?? 'unknown'} for --list): ${(manifest.stderr || listedRun.stderr).trim() || 'no output'}`);
  const printed = (manifest.stdout.trim() || 'nothing').slice(0, 200);
  const listedNote = listedValue
    ? `--list printed ${JSON.stringify(listedValue)}${listed.refusal ? `, which the server refuses (${listed.refusal})` : ', which is not a list of exact repository-relative paths'}`
    : '--list printed nothing usable';
  throw new Error(`The generated-file manifest did not parse: ${generatedManifestScript} --manifest printed ${printed} and ${listedNote}`);
}
