// Inevitable scope companions (GY-955), apart from model/scope.ts so that module keeps its budget.
//
// A change carries files no criterion names: the new test file its own unit proofs live in, the existing
// tests that import a module it changes, the documentation-budget gate any documented change must raise,
// the wall-clock gate a test change must keep passing (GY-1706), the test-duration baseline a new test
// file is recorded in (GY-1085) and the verification map covering a planned file (GY-1783). Each was
// refused wholesale and approved minutes later as "the feature implementation, not optional add-ons"
// (GY-945, GY-883). These rules ground them per path, so the loop grants them with no approver, and
// `derivePlannedFiles` plans them at authoring time.
import { documentationGlobMatches } from './documentation-glob.js';
import type { FaultClass } from './fault-classes.js';
import { ciCheckName } from './ci-refusal.js';
import type { WorkOrigin } from './interventions.js';
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

/** Candidate, observed checks and gates the failed-check ground reads. */
export interface GateRecord { name: string; passed: boolean; reasons: readonly string[] }
export interface FailedCheckSource { candidate?: { sha: string } | null; observation?: { candidate?: { sha: string } | null; checks?: readonly { name: string; result: string }[] } | null; gates?: readonly GateRecord[] }
/**
 * GY-1893: modules each fault class's instances are produced and answered in. Filing plans only
 * the proof test (GY-1706); `impliedScopes` / `plannedCompanions` grant the class's machinery so
 * the item never waits out the bound. Decision and scope are tabled from their instances.
 */
export const faultClassMachinery: Partial<Record<FaultClass, readonly string[]>> = {
  decision: ['src/daemon/decision-text.ts', 'src/daemon/cycle-decisions.ts', 'src/daemon/cycle-approvers.ts'],
  scope: ['src/review-scope.ts', 'src/daemon/cycle-scope.ts', 'src/model/scope.ts', 'src/model/scope-companions.ts', 'src/model/scope-collapse.ts'],
};
/** Machinery of the fault class an item closes, or none. */
export const machineryOf = (origin?: WorkOrigin | null): readonly string[] =>
  origin?.faultClass ? faultClassMachinery[origin.faultClass.class] ?? [] : [];
const testStemParts = (path: string) => {
  const match = /^((?:[^/]+\/)*)([^/]+?)(\.(?:test|spec)\.[cm]?[jt]sx?)$/.exec(pathScope(path).path);
  return match && testFile(path) ? { directory: match[1], stem: match[2], suffix: match[3] } : null;
};
/** Proof-named test, or same-suffix hyphenated stem lengthening/shortening it (GY-1700); single-token stems never match (GY-945). */
const proofTestStemMatch = (path: string, named: string) => {
  if (path === named) return true;
  const asked = testStemParts(path), proof = testStemParts(named);
  if (!asked || !proof || asked.directory !== proof.directory || asked.suffix !== proof.suffix) return false;
  const [shorter, longer] = asked.stem.length <= proof.stem.length ? [asked.stem, proof.stem] : [proof.stem, asked.stem];
  return shorter.includes('-') && longer.startsWith(`${shorter}-`);
};
export const documentationPath = (path: string, documentation: readonly string[]) =>
  documentation.some(scope => documentationGlobMatches(scope, path) || pathScope(path).prefix && pathScopeContains(path, pathScope(scope).path));

/** Test directory and extension from the tree; `tests/` + `.test.ts` by default. */
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
/** Test file named for shared proof words, or the first proof when they share none. */
export function proofTestFile(proofs: readonly string[], layout = testLayout()) {
  const words = proofWords(proofs);
  if (!words.length) return null;
  const shared = sharedWords(words);
  return `${layout.directory}${(shared.length ? shared : words[0]).join('-')}${layout.extension}`;
}
/** One shared-word file for all criteria's test proofs, else one per criterion (GY-945). */
export function proofTestFiles(criteria: readonly CompanionCriterion[], layout = testLayout()) {
  const entries = criterionTestProofs(criteria), all = entries.flatMap(entry => entry.proofs);
  if (entries.length > 1 && sharedWords(proofWords(all)).length) return [{ path: proofTestFile(all, layout)!, criterion: entries.map(entry => entry.criterion).join(', '), proofs: all }];
  return entries.map(entry => ({ path: proofTestFile(entry.proofs, layout)!, criterion: entry.criterion, proofs: entry.proofs }));
}
const webUi = /\b(?:web (?:UI|app|page|dashboard)|dashboard)\b/i;
export type FollowUpSource = { origin?: WorkOrigin | null; description?: string | null };

/** Finding paths plus unambiguous path tokens in finding/description text; dotted API names are prose (GY-1116). */
export function followUpPaths(findings: readonly { path?: string | null; text: string }[], description?: string | null): string[] {
  const named = (text: string) => namedPaths(text).filter(token => /\/[^/]+\.[A-Za-z0-9]{1,5}$/.test(token));
  return [...new Set([...findings.flatMap(finding => [...(finding.path ? [finding.path] : []), ...named(finding.text)]), ...(description ? named(description) : [])])];
}

/** Peer module: planned file imports `path`, or `path` imports a planned file. `read` is base text. */
export async function peerModuleGround(path: string, text: string | null, plannedFiles: readonly string[], read: (path: string) => Promise<string | null>): Promise<string | null> {
  if (pathScope(path).prefix || !codeExtension.test(path) || testFile(path)) return null;
  const planned = plannedFiles.filter(scope => !pathScope(scope).prefix && codeExtension.test(scope) && scope !== path && !testFile(scope));
  if (!planned.length) return null;
  const targetStem = moduleStem(path);
  for (const scope of planned) {
    const source = await read(scope);
    if (source && relativeImports(scope, source).includes(targetStem)) return `${path} is imported by ${scope}, a planned file whose behaviour the item changes`;
  }
  if (text) {
    const stems = new Map(planned.map(scope => [moduleStem(scope), scope]));
    for (const stem of relativeImports(path, text)) if (stems.has(stem)) return `${path} imports ${stems.get(stem)}, a planned file whose behaviour the item changes`;
  }
  return null;
}

/** Prose names the check (paths stripped so `.test.ts` never counts as the `test` check). */
const reasonNamesCheck = (reason: string, name: string) => {
  let prose = reason;
  for (const path of namedPaths(reason)) prose = prose.split(path).join(' ');
  prose = prose.replace(/:\d+/g, ' ');
  return new RegExp(`(?:^|[^\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^\\w.-]|$)`, 'i').test(prose);
};
const reasonQuotesFailureSite = (reason: string, path: string) =>
  new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+`).test(reason);
/**
 * GY-1893 / GY-1881: grant the existing test file a failed required check on the current candidate
 * names, when the ask names that held check and quotes `PATH:LINE`. A red gate alone, a check the
 * record does not hold, a file not at the failure site, or a non-test path grants nothing.
 */
export function failedCheckTestGround(path: string, item: FailedCheckSource, reason?: string): string | null {
  if (!reason || !testFile(path) || !item.candidate || !namedPaths(reason).includes(path)) return null;
  if (!reasonQuotesFailureSite(reason, path)) return null;
  if (item.observation?.candidate?.sha !== item.candidate.sha) return null;
  const failed = [...new Set((item.observation?.checks ?? []).filter(check => check.result === 'failure').map(check => check.name)
    .filter(name => (item.gates ?? []).some(gate => !gate.passed && gate.reasons.some(held => ciCheckName(held) === name)))
    .filter(name => reasonNamesCheck(reason, name)))];
  return failed.length ? `${path} is the test file the failed required check ${failed.join(' and ')} on this item's current candidate names, which the item answers within its attempt` : null;
}
/**
 * Companion ground from the item's record alone (no base read): docs-budget / timing / wall-clock
 * gates, proof-named test files, a single `web/` file a criterion describes, and GY-1893's failed
 * required-check test file (reason names the check and `PATH:LINE`). Import/proof-held grounds are the loop's.
 */
export function companionGround(path: string, item: { plannedFiles?: readonly string[]; criteria: readonly CompanionCriterion[]; origin?: WorkOrigin | null; description?: string | null } & FailedCheckSource, ask: readonly string[], documentation: readonly string[], reason?: string): string | null {
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
  const described = path.startsWith('web/') && !testFile(path) ? item.criteria.find(criterion => webUi.test(criterion.text)) : undefined;
  if (described) return `${path} is the web UI ${described.id} describes`;
  return failedCheckTestGround(path, item, reason);
}

/** GY-955 AC-1(b): new test file when some criterion's test proofs are held by no base file. */
export async function newProofTestGround(path: string, criteria: readonly CompanionCriterion[], held: (proof: string) => Promise<number>): Promise<string | null> {
  if (!testFile(path)) return null;
  const directory = path.slice(0, path.lastIndexOf('/') + 1), extension = /\.(?:test|spec)\.[cm]?[jt]sx?$/.exec(path)?.[0];
  for (const entry of criterionTestProofs(criteria)) {
    const unheld: string[] = [];
    for (const proof of entry.proofs) if (await held(proof) === 0) unheld.push(proof);
    if (!unheld.length) continue;
    // Fault-class manual proofs must match the proof-named file or its hyphenated stem (GY-1287 / GY-1701).
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
export const moduleFiles = (stem: string) => ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx', '/index.ts', '/index.js'].map(suffix => `${stem}${suffix}`);

/** GY-955 AC-1(a): existing test that imports a planned file, or a barrel that re-exports one. */
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

export const verificationMapFile = (path: string) => !pathScope(path).prefix && /^verification\/[^/]+\.md$/.test(pathScope(path).path);
/** Wall-clock / timing / docs-budget gate: companion of a test in the ask, not an independent ground. */
export const testCompanionGate = (path: string) => noWallClockGate(path) || timingBaseline(path) || documentationBudgetGate(path);
const verificationMapPaths = (text: string) => {
  const opening = text.replace(/\r\n/g, '\n').split('\n').find(line => line.trim())?.match(/^Paths:\s*(.*)$/);
  const paths = opening?.[1].split(/[\s,]+/).filter(Boolean) ?? [];
  return paths.length ? paths : null;
};
/**
 * GY-1783: grant a verification map whose `Paths:` covers a planned file, a criterion-named test,
 * or a previously grounded test (never the raw ask alone, never a `testCompanionGate`). Base text
 * required; a map with no Paths line or no covered file stays refused.
 */
export function verificationMapGround(path: string, text: string | null, item: { plannedFiles?: readonly string[]; criteria: readonly CompanionCriterion[] }, granted: readonly string[] = []): string | null {
  if (!text || !verificationMapFile(path)) return null;
  const paths = verificationMapPaths(text);
  if (!paths) return null;
  const line = `Paths: ${paths.join(', ')}`;
  // Leading `./` stripped like verificationGlobCovers (not imported: reaches scope.ts via documentation.ts).
  const covered = (entry: string) => entry !== path && paths.some(glob => documentationGlobMatches(glob, entry) || pathScope(entry).prefix && glob.replace(/^\.\//, '').startsWith(pathScope(entry).path));
  const planned = (item.plannedFiles ?? []).find(covered);
  if (planned) return `${path} is the verification map whose ${line} covers ${planned}, a planned file whose behaviour the item changes`;
  const created = item.criteria.flatMap(criterion => namedPaths(criterion.text)).find(entry => testFile(entry) && covered(entry));
  if (created) return `${path} is the verification map whose ${line} covers ${created}, a test file the item creates`;
  const companion = granted.find(entry => testFile(entry) && !testCompanionGate(entry) && covered(entry));
  if (companion) return `${path} is the verification map whose ${line} covers ${companion}, a test file this request grants`;
  return null;
}

/** GY-955 AC-2: authoring-time companions — proof test, wall-clock/timing/docs gates, follow-up paths, fault-class machinery. */
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
  const closed = item.origin?.faultClass;
  if (closed)
    for (const file of machineryOf(item.origin))
      if (tree.has(file) && !covered(file)) added.push({ path: file, criterion: 'AC-1', why: `the ${closed.class} fault class's machinery, where the shared cause AC-1 removes lives` });
  return added;
}
