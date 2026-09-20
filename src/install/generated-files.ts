import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseGeneratedFiles } from '../generated-files.js';
import { parseGeneratedManifest } from '../sync.js';

/**
 * The generated-files deployment variable every installer sets beside GRAPHYARD_PRINCIPALS, next
 * to the capacity limits: the comma-separated exact repository-relative paths the managed
 * repository's generated-file manifest declares. Unset, the regression guard exempts nothing, so
 * a repository whose manifest declares generated pages hits the same out-of-scope refusal on
 * every docs-touching item until an installer derives and sets the value from that manifest.
 */
export const generatedFilesVariable = 'GRAPHYARD_GENERATED_FILES' as const;

/** The repository script that declares the manifest; a repository without it declares none. */
export const generatedManifestScript = 'scripts/check-docs.mjs';

/** What an installer writes beside GRAPHYARD_PRINCIPALS for one repository's manifest. */
export interface GeneratedFilesAssignment { variable: typeof generatedFilesVariable; files: string[]; value: string; line: string }

const runManifestScript = (root: string, args: string[]) =>
  spawnSync(process.execPath, [generatedManifestScript, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

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

const sameFiles = (a: readonly string[], b: readonly string[]) => {
  const left = [...a].sort(), right = [...b].sort();
  return a.length === b.length && left.every((entry, index) => entry === right[index]);
};

/**
 * The drift between the deployed `GRAPHYARD_GENERATED_FILES` value and the repository manifest,
 * as the exact sentences master status raises: each names the value to set, so the attention
 * owner resolves the one command that fixes the deployment. A repository without a manifest
 * never drifts — unset is its correct deployment state.
 */
export function generatedFilesDrift(deployed: string | null | undefined, manifest: GeneratedFilesAssignment | null): string[] {
  if (!manifest) return [];
  let declared: string[] | null;
  try { declared = deployed == null || deployed === '' ? [] : parseGeneratedFiles(deployed); }
  catch { declared = null; }
  if (declared && sameFiles(declared, manifest.files)) return [];
  const report = deployed === undefined
    ? `The deployment does not report ${generatedFilesVariable} (deploy main first), so the regression guard may treat every file as owned`
    : declared === null
      ? `${generatedFilesVariable} on the deployment does not parse (${JSON.stringify(deployed)}) and the server refuses it at start-up`
      : declared.length
        ? `${generatedFilesVariable}=${declared.join(',')} on the deployment no longer matches the repository manifest`
        : `${generatedFilesVariable} is unset on the deployment, so the regression guard treats every file as owned`;
  return [`${report}; the repository manifest declares ${manifest.value}. Set ${manifest.line} on the deployment.`];
}
