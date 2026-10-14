// Inevitable scope companions (GY-955), apart from model/scope.ts so that module keeps its budget.
//
// A change carries files no criterion names: the new test file its own unit proofs live in, the
// existing tests that import a module it changes, the documentation-budget gate any documented
// change must raise, the wall-clock gate a test change must keep passing (GY-1706), and the
// test-duration baseline a new test file is recorded in (GY-1085). Each was refused wholesale and
// approved minutes later by the approver as "the feature implementation, not optional add-ons"
// (GY-945, GY-883). These rules ground them per path, so the loop grants them with no approver,
// and `derivePlannedFiles` plans them at authoring time.
import { documentationGlobMatches } from './documentation-glob.js';
import { namedPaths, pathScope, pathScopeContains, testFile } from './scope.js';

interface CompanionCriterion { id: string; text: string; proofs?: readonly string[] }

/**
 * The proofs a test file holds: unit and integration proofs, and the fault-class manual proofs the
 * loop's own filing writes (`manual:fault-class-*`, GY-1706). Other manual, E2E and CI proofs live elsewhere.
 */
export const testProof = (proof: string) => /^(?:unit|integration):[\w.-]+$/.test(proof) || /^manual:fault-class-[\w.-]+$/.test(proof);
/** Each criterion's test proofs, for the criteria that have any. */
export const criterionTestProofs = (criteria: readonly CompanionCriterion[]) =>
  criteria.flatMap(criterion => { const proofs = [...new Set((criterion.proofs ?? []).filter(testProof))]; return proofs.length ? [{ criterion: criterion.id, proofs }] : []; });

/** The repository's documentation-budget gate: the test that counts the documentation's words (tests/docs-budget.test.ts). */
export const documentationBudgetGate = (path: string) => testFile(path) && /(?:^|\/)docs?[-_.]?(?:word[-_.]?)?budget\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);
/**
 * The per-test-file duration record a sharded suite balances by (tests/helpers/timing-baseline.json): a
 * coverage floor over it (tests/ci-shards.test.ts) fails the required test check unless a new test file
 * gets its entry, so it is a companion of every test file a change plans or asks for (GY-1085).
 */
export const timingBaseline = (path: string) => !pathScope(path).prefix && /(?:^|\/)(?:tests?|__tests__)\/(?:[\w.-]+\/)*timing[-_.]?baseline\.json$/i.test(path);
/**
 * The wall-clock gate (tests/no-wall-clock-time-bombs.test.ts): a change that adds or edits a test
 * file must keep its allowance in step, so it is a companion of every test file a change plans or
 * asks for (GY-1706).
 */
export const noWallClockGatePath = 'tests/no-wall-clock-time-bombs.test.ts';
export const noWallClockGate = (path: string) => path === noWallClockGatePath;
const testScope = (entry: string) => testFile(entry) || pathScope(entry).prefix && /(?:^|\/)(?:tests?|__tests__)\/$/.test(pathScope(entry).path);
/** A test path's directory, stem and suffix, or null — used to match a shorter ask to a proof-named file. */
const testStemParts = (path: string) => {
  const match = /^((?:[^/]+\/)*)([^/]+?)(\.(?:test|spec)\.[cm]?[jt]sx?)$/.exec(pathScope(path).path);
  return match && testFile(path) ? { directory: match[1], stem: match[2], suffix: match[3] } : null;
};
/**
 * True when `path` is the proof-named test, or a same-suffix stem that lengthens or shortens it by
 * a hyphenated suffix (GY-1700's webhook-soft-accept beside unit:webhook-soft-accept-no-5xx). The
 * shorter stem must itself be hyphenated so a single token (fleet vs fleet-panel) is never a match
 * (GY-945's new-file path must still reach newProofTestGround).
 */
const proofTestStemMatch = (path: string, named: string) => {
  if (path === named) return true;
  const asked = testStemParts(path), proof = testStemParts(named);
  if (!asked || !proof || asked.directory !== proof.directory || asked.suffix !== proof.suffix) return false;
  const [shorter, longer] = asked.stem.length <= proof.stem.length ? [asked.stem, proof.stem] : [proof.stem, asked.stem];
  return shorter.includes('-') && longer.startsWith(`${shorter}-`);
};
/** True when `path` is, or a scope that holds, documentation the item's repository configures. */
export const documentationPath = (path: string, documentation: readonly string[]) =>
  documentation.some(scope => documentationGlobMatches(scope, path) || pathScope(path).prefix && pathScopeContains(path, pathScope(scope).path));

/** Where a repository keeps its tests and how it names them, read from its tree: `tests/` and `.test.ts` by default. */
export function testLayout(tree: Iterable<string> = []) {
  const counts = new Map<string, number>();
  for (const file of tree) {
    const match = /^((?:[\w.-]+\/)*?(?:tests?|__tests__)\/)[^/]+(\.(?:test|spec)\.[cm]?[jt]sx?)$/.exec(file);
    if (match) counts.set(`${match[1]}\0${match[2]}`, (counts.get(`${match[1]}\0${match[2]}`) ?? 0) + 1);
  }
  const [layout] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['tests/\0.test.ts'];
  const [directory, extension] = layout.split('\0');
  return { directory, extension };
}
const proofWords = (proofs: readonly string[]) => proofs.map(proof => proof.replace(/^[a-z]+:/, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)).filter(entry => entry.length);
const sharedWords = (words: readonly string[][]) => words.slice(1).reduce((shared, entry) => { let index = 0; while (index < shared.length && shared[index] === entry[index]) index++; return shared.slice(0, index); }, words[0] ?? []);
/**
 * The test file a criterion's proofs will live in when no file holds them yet: named for the words
 * the proof names share (`unit:fleet-panel-renders-registry` and `unit:fleet-panel-marks-stale-probe`
 * live in `tests/fleet-panel.test.ts`), or for the first proof when they share none.
 */
export function proofTestFile(proofs: readonly string[], layout = testLayout()) {
  const words = proofWords(proofs);
  if (!words.length) return null;
  const shared = sharedWords(words);
  return `${layout.directory}${(shared.length ? shared : words[0]).join('-')}${layout.extension}`;
}
/**
 * The test files an item's proofs will live in: one named for what every criterion's test proofs
 * share when they share a word (GY-945's two criteria share `fleet-panel`), otherwise one per criterion.
 */
export function proofTestFiles(criteria: readonly CompanionCriterion[], layout = testLayout()) {
  const entries = criterionTestProofs(criteria), all = entries.flatMap(entry => entry.proofs);
  if (entries.length > 1 && sharedWords(proofWords(all)).length) return [{ path: proofTestFile(all, layout)!, criterion: entries.map(entry => entry.criterion).join(', '), proofs: all }];
  return entries.map(entry => ({ path: proofTestFile(entry.proofs, layout)!, criterion: entry.criterion, proofs: entry.proofs }));
}
/** A criterion that describes a change in the web UI: what makes a single file under `web/` the feature it describes. */
const webUi = /\b(?:web (?:UI|app|page|dashboard)|dashboard)\b/i;

import type { WorkOrigin } from './interventions.js';

/** The fields of an item that make it a review follow-up and say what it names (GY-1116). */
export type FollowUpSource = { origin?: WorkOrigin | null; description?: string | null };

/**
 * The files a review follow-up names (GY-1116): each finding's own path, and the paths its text or the
 * item's description name unambiguously — a directory and a file extension. A dotted API name
 * (`store.init`) is prose, not a file, so it never lands in plannedFiles or implies scope.
 */
export function followUpPaths(findings: readonly { path?: string | null; text: string }[], description?: string | null): string[] {
  const named = (text: string) => namedPaths(text).filter(token => /\/[^/]+\.[A-Za-z0-9]{1,5}$/.test(token));
  return [...new Set([...findings.flatMap(finding => [...(finding.path ? [finding.path] : []), ...named(finding.text)]), ...(description ? named(description) : [])])];
}

/**
 * Structural ground for a peer module: an existing source module that a planned file directly
 * imports by relative specifier, or that directly imports a planned file.
 * `read` answers a module's text on the base branch, null when absent.
 */
export async function peerModuleGround(path: string, text: string | null, plannedFiles: readonly string[], read: (path: string) => Promise<string | null>): Promise<string | null> {
  if (pathScope(path).prefix || !codeExtension.test(path) || testFile(path)) return null;
  const planned = plannedFiles.filter(scope => !pathScope(scope).prefix && codeExtension.test(scope) && scope !== path && !testFile(scope));
  if (!planned.length) return null;
  const targetStem = moduleStem(path);

  // 1. A planned file imports path (peer dependency / implementation delegate):
  for (const scope of planned) {
    const source = await read(scope);
    if (!source) continue;
    const imports = relativeImports(scope, source);
    if (imports.includes(targetStem)) {
      return `${path} is imported by ${scope}, a planned file whose behaviour the item changes`;
    }
  }

  // 2. path imports a planned file (peer consumer):
  if (text) {
    const stems = new Map(planned.map(scope => [moduleStem(scope), scope]));
    const imports = relativeImports(path, text);
    for (const stem of imports) {
      if (stems.has(stem)) {
        return `${path} imports ${stems.get(stem)}, a planned file whose behaviour the item changes`;
      }
    }
  }

  return null;
}

/**
 * The ground a requested path stands on as a companion the item's own record implies, or null. These
 * need no file read: the documentation-budget gate, when the ask or the plan holds documentation;
 * the test-duration baseline, when it holds a test file; the test file named for the criteria's proofs (`proofTestFiles`); and a single file under `web/`
 * when a criterion describes a change in the web UI (GY-945's page and stylesheet). The engine's rule grants
 * these; what needs the base branch — imports, and which proofs a file already holds — is the
 * loop's (`importingTestGround`, `newProofTestGround`, `peerModuleGround`).
 */
export function companionGround(path: string, item: { plannedFiles?: readonly string[]; criteria: readonly CompanionCriterion[]; origin?: WorkOrigin | null; description?: string | null }, ask: readonly string[], documentation: readonly string[]): string | null {
  if (pathScope(path).prefix) return null;
  if (documentationBudgetGate(path)) {
    const documented = [...ask, ...(item.plannedFiles ?? [])].find(entry => entry !== path && documentationPath(entry, documentation));
    if (documented) return `${path} is the documentation-budget gate a change to ${documented} must keep passing`;
  }
  if (timingBaseline(path)) {
    const tested = [...ask, ...(item.plannedFiles ?? [])].find(entry => entry !== path && testScope(entry) && !timingBaseline(entry) && !noWallClockGate(entry));
    if (tested) return `${path} is the test-duration baseline a change to ${tested} must keep covering`;
  }
  if (noWallClockGate(path)) {
    const tested = [...ask, ...(item.plannedFiles ?? [])].find(entry => entry !== path && testScope(entry) && !timingBaseline(entry) && !noWallClockGate(entry));
    if (tested) return `${path} is the wall-clock gate a change to ${tested} must keep passing`;
  }
  if (testFile(path)) {
    const directory = path.slice(0, path.lastIndexOf('/') + 1), extension = /\.(?:test|spec)\.[cm]?[jt]sx?$/.exec(path)?.[0];
    const layout = { directory, extension: extension ?? '' };
    if (extension) for (const entry of [...proofTestFiles(item.criteria, layout), ...criterionTestProofs(item.criteria).map(each => ({ ...each, path: proofTestFile(each.proofs, layout) }))])
      if (entry.path && proofTestStemMatch(path, entry.path)) return `${path} is the test file ${entry.criterion}'s proofs (${entry.proofs.join(', ')}) live in`;
  }
  // The feature a criterion describes in the web UI is a page, component or stylesheet under web/: one file, never the tree.
  const described = path.startsWith('web/') && !testFile(path) ? item.criteria.find(criterion => webUi.test(criterion.text)) : undefined;
  if (described) return `${path} is the web UI ${described.id} describes`;
  return null;
}

/**
 * GY-955 AC-1(b): the ground a new test file is granted on — one the base does not hold — when some
 * criterion's test proofs are held by no file on the base, so the change must write them somewhere
 * new. `held` answers how many base files hold a proof name; a failed search reads as held.
 */
export async function newProofTestGround(path: string, criteria: readonly CompanionCriterion[], held: (proof: string) => Promise<number>): Promise<string | null> {
  if (!testFile(path)) return null;
  const directory = path.slice(0, path.lastIndexOf('/') + 1), extension = /\.(?:test|spec)\.[cm]?[jt]sx?$/.exec(path)?.[0];
  for (const entry of criterionTestProofs(criteria)) {
    const unheld: string[] = [];
    for (const proof of entry.proofs) if (await held(proof) === 0) unheld.push(proof);
    if (!unheld.length) continue;
    // Fault-class manual proofs live in the proof-named file (or its hyphenated stem); an unrelated
    // test path is not "whatever it is called" the way unit proofs are (GY-1287 / GY-1701).
    if (unheld.some(proof => /^manual:fault-class-/.test(proof))) {
      if (!extension) continue;
      const named = proofTestFile(entry.proofs, { directory, extension });
      if (!named || !proofTestStemMatch(path, named)) continue;
    }
    return `${path} is the new test file ${entry.criterion}'s proofs (${unheld.join(', ')}) live in; no file on the base holds them`;
  }
  return null;
}

const codeExtension = /\.(?:[cm]?[jt]sx?)$/;
const moduleStem = (path: string) => path.replace(codeExtension, '').replace(/\/index$/, '');
/** The repository modules a file imports or re-exports by relative specifier, as path stems. */
export function relativeImports(path: string, text: string) {
  const stems = new Set<string>();
  for (const match of text.matchAll(/\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*(?:\(\s*)?['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const parts = path.split('/').slice(0, -1);
    for (const segment of (match[1] ?? match[2]).split('/')) {
      if (segment === '..') parts.pop();
      else if (segment !== '.') parts.push(segment);
    }
    stems.add(moduleStem(parts.join('/')));
  }
  return [...stems];
}
/** The files a module stem may be on disk, most likely first. */
export const moduleFiles = (stem: string) => ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx', '/index.ts', '/index.js'].map(suffix => `${stem}${suffix}`);

/**
 * GY-955 AC-1(a): the ground an existing test file is granted on because it imports a module a
 * planned file is, or a module that re-exports a planned file (a barrel such as src/model.ts over
 * src/model/gates.ts), or one a planned barrel re-exports. The test pins the behaviour the item
 * changes, so the change breaks it. `read` answers a module's text on the base, null when absent.
 */
export async function importingTestGround(path: string, text: string | null, plannedFiles: readonly string[], read: (path: string) => Promise<string | null>, limit = 20): Promise<string | null> {
  if (!text || !testFile(path)) return null;
  const planned = plannedFiles.filter(scope => !pathScope(scope).prefix && codeExtension.test(scope) && scope !== path);
  if (!planned.length) return null;
  const stems = new Map(planned.map(scope => [moduleStem(scope), scope]));
  const imports = relativeImports(path, text);
  for (const stem of imports) if (stems.has(stem)) return `${path} imports ${stems.get(stem)}, a planned file whose behaviour the item changes`;
  for (const stem of imports.slice(0, limit)) {
    let module: string | null = null, source: string | null = null;
    for (const candidate of moduleFiles(stem)) if ((source = await read(candidate)) !== null) { module = candidate; break; }
    if (!module || !source) continue;
    const reexported = [...source.matchAll(/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g)]
      .flatMap(match => relativeImports(module!, `from '${match[1]}'`)).find(entry => stems.has(entry));
    if (reexported) return `${path} imports ${module}, which re-exports planned file ${stems.get(reexported)}`;
  }
  for (const scope of planned) {
    const source = await read(scope);
    if (!source) continue;
    const barrel = relativeImports(scope, (source.match(/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"][^'"]+['"]/g) ?? []).join('\n')).find(stem => imports.includes(stem));
    if (barrel) return `${path} imports ${barrel}, which planned file ${scope} re-exports`;
  }
  return null;
}

/** A per-area verification map (verification/AREA.md, GY-1495): a file, never the tree. */
export const verificationMapFile = (path: string) => !pathScope(path).prefix && /^verification\/[^/]+\.md$/.test(path);
/** The globs a map's opening `Paths:` line names, as parseVerificationMap reads them, or null when the text opens with no such line. */
const verificationMapPaths = (text: string) => {
  const opening = text.replace(/\r\n/g, '\n').split('\n').find(line => line.trim())?.match(/^Paths:\s*(.*)$/);
  const paths = opening?.[1].split(/[\s,]+/).filter(Boolean) ?? [];
  return paths.length ? paths : null;
};
/**
 * GY-1783: the ground a verification map is granted on. A map opens with a `Paths:` line naming the
 * globs it covers and holds the `## Tests` list the repository names an area's test files in, so an
 * item that changes a file under those paths, or creates a test for one, must edit the map — the
 * same way the test importing a planned file is granted (importingTestGround). The ground names the
 * planned file the map's Paths line covers, or the test file under those paths a criterion names or
 * this same request has already granted (`granted`: the paths the rules grounded before the map,
 * never the raw ask, so a map covering only an unrelated test asked beside it is not granted on that
 * test), and the line itself. `text` is the map on the base: a map the base does not hold, one that
 * opens with no Paths line, or one whose paths cover none of those files is not grounded here and
 * stays refused and routed as before.
 */
export function verificationMapGround(path: string, text: string | null, item: { plannedFiles?: readonly string[]; criteria: readonly CompanionCriterion[] }, granted: readonly string[] = []): string | null {
  if (!text || !verificationMapFile(path)) return null;
  const paths = verificationMapPaths(text);
  if (!paths) return null;
  const line = `Paths: ${paths.join(', ')}`;
  // As verificationGlobCovers reads a glob (verification-maps.ts, not imported: it reaches scope.ts back through
  // documentation.ts): a leading `./` is stripped from the glob as from the entry, so `Paths: ./src/master/**` covers
  // a planned `src/` the way documentationGlobMatches already covers a planned file under it (review of 8aac4bbf).
  const covered = (entry: string) => entry !== path && paths.some(glob => documentationGlobMatches(glob, entry) || pathScope(entry).prefix && glob.replace(/^\.\//, '').startsWith(pathScope(entry).path));
  const planned = (item.plannedFiles ?? []).find(covered);
  if (planned) return `${path} is the verification map whose ${line} covers ${planned}, a planned file whose behaviour the item changes`;
  const created = item.criteria.flatMap(criterion => namedPaths(criterion.text)).find(entry => testFile(entry) && covered(entry));
  if (created) return `${path} is the verification map whose ${line} covers ${created}, a test file the item creates`;
  const companion = granted.find(entry => testFile(entry) && covered(entry));
  if (companion) return `${path} is the verification map whose ${line} covers ${companion}, a test file this request grants`;
  return null;
}

/**
 * GY-955 AC-2: the companions plannedFiles carries at authoring time, beside what the criteria name.
 * The test file each criterion's proofs will live in, when the plan holds no test file for them —
 * the one already named for the proofs on the base, or the new one `proofTestFile` names — the
 * wall-clock gate and timing baseline the tree holds when the plan holds a test, and the
 * documentation-budget gate when the plan holds documentation.
 */
export function plannedCompanions(item: { plannedFiles: readonly string[]; criteria: readonly CompanionCriterion[]; origin?: WorkOrigin | null; description?: string | null }, tree: ReadonlySet<string>, documentation: readonly string[]) {
  const added: { path: string; criterion: string | null; why: string }[] = [];
  const covered = (path: string) => item.plannedFiles.some(entry => pathScopeContains(entry, path)) || added.some(entry => entry.path === path);
  const layout = testLayout(tree);
  if (!item.plannedFiles.some(testScope))
    for (const entry of proofTestFiles(item.criteria, layout))
      if (!covered(entry.path)) added.push({ path: entry.path, criterion: entry.criterion.split(', ')[0], why: `the test file ${entry.criterion}'s proofs live in` });
  const holdsTest = [...item.plannedFiles, ...added.map(entry => entry.path)].some(entry => testScope(entry) && !timingBaseline(entry) && !noWallClockGate(entry));
  if (holdsTest)
    for (const file of tree) if (timingBaseline(file) && !covered(file)) added.push({ path: file, criterion: null, why: 'the test-duration baseline a new test file must be recorded in' });
  if (holdsTest)
    for (const file of tree) if (noWallClockGate(file) && !covered(file)) added.push({ path: file, criterion: null, why: 'the wall-clock gate a test change must keep passing' });
  if (item.plannedFiles.some(entry => documentationPath(entry, documentation)))
    for (const file of tree) if (documentationBudgetGate(file) && !covered(file)) added.push({ path: file, criterion: null, why: 'the documentation-budget gate a documented change must keep passing' });
  if (item.origin?.reviewFollowUps)
    for (const file of followUpPaths(item.origin.reviewFollowUps.findings ?? [], item.description))
      if (tree.has(file) && !covered(file)) added.push({ path: file, criterion: 'FOLLOWUP', why: 'the file a review follow-up names' });
  return added;
}
