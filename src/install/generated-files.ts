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

/**
 * Derive the generated-files deployment variable from the managed repository's manifest: the
 * value `node scripts/check-docs.mjs --list` prints — the comma-separated form the server
 * parses — falling back to the manifest JSON for a script that predates `--list`. Returns null
 * when the repository declares no manifest, and refuses with a clear message when a declared
 * manifest fails or prints a value the server would not accept, so an installer never stays
 * silent about a declaration it could not read.
 */
export function generatedFilesAssignment(root: string): GeneratedFilesAssignment | null {
  if (!existsSync(resolve(root, generatedManifestScript))) return null;
  let value: string;
  const listed = runManifestScript(root, ['--list']);
  if (listed.status === 0) value = listed.stdout.trim();
  else {
    const manifest = runManifestScript(root, ['--manifest']);
    if (manifest.status !== 0) throw new Error(`The generated-file manifest failed (${generatedManifestScript} exited ${manifest.status ?? 'unknown'}): ${(manifest.stderr || listed.stderr).trim() || 'no output'}`);
    const parsed = parseGeneratedManifest(manifest.stdout);
    if (!parsed) throw new Error(`The generated-file manifest did not parse: ${generatedManifestScript} --manifest printed ${(manifest.stdout.trim() || 'nothing').slice(0, 200)}`);
    value = parsed.files.join(',');
  }
  // The server refuses an unparseable value at start-up (src/generated-files.ts), so the
  // derivation is held to the same contract here: the documented command yields a value the
  // deployment accepts, never one it would crash-loop on.
  const files = parseGeneratedFiles(value);
  if (!files.length) return null;
  return { variable: generatedFilesVariable, files, value: files.join(','), line: `${generatedFilesVariable}=${files.join(',')}` };
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
