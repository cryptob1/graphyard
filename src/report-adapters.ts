import { createHash } from 'node:crypto';
import { z } from 'zod';
import { runnerReport, verifyRunnerReport } from './runner-report.js';

/**
 * Supported report formats. A format is pinned in the operator-approved bundle definition
 * beside the runner image digest, travels to the runner and the collector through the
 * dispatch grant, and is therefore covered by the signed attestation's grant digest. It is
 * never chosen by a runner input file or inferred from whatever bytes the boundary holds:
 * a report in a format the approval did not name is refused, not sniffed.
 */
export const reportFormats = ['graphyard-playwright-v1', 'junit-xml-v1'] as const;
export type ReportFormat = (typeof reportFormats)[number];
export const defaultReportFormat: ReportFormat = 'graphyard-playwright-v1';

export type ArtifactKindName = 'inventory' | 'report';
export type ReportVerification = { passed: boolean; inventoryComplete: boolean; executed: number; skipped: number; reasons: string[] };
export type ParsedArtifact = {
  /** The normalised, data-minimised document the verifier judges. */
  document: unknown;
  /** The bytes a collector may durably publish for this artifact. For a format whose raw
   * output can carry messages, stdout or stack traces these are the minimised projection,
   * never the raw bytes read from the boundary. */
  published: { bytes: Buffer; mediaType: 'application/json' };
};

/**
 * What one adapter is, in terms an operator can hold it to. Every field here is part of
 * the adapter's published contract (`graphyard runner adapters`), so a format is never
 * supported by implication: it states what it proves, what was independently observed
 * rather than reported, which producers and versions its fixtures cover, and how each
 * failure is classified.
 */
export interface ReportAdapter {
  format: ReportFormat;
  kind: 'e2e' | 'unit-integration';
  /** Producers whose real output the contract fixtures cover. Others are unsupported, not "probably fine". */
  producers: { name: string; versions: string }[];
  artifacts: Record<ArtifactKindName, { file: string; mediaType: 'application/json' | 'application/xml' }>;
  /** What an accepted verification establishes. */
  proves: string[];
  /** Which of those facts come from an independent observation rather than the report's own claims. */
  observed: string[];
  /** What acceptance under this adapter does not establish. */
  notProven: string[];
  /** How each condition in the raw output is classified. Nothing here yields a pass. */
  failureSemantics: Record<string, string>;
  parse(kind: ArtifactKindName, bytes: Buffer): ParsedArtifact;
  verify(inventory: unknown, report: unknown): ReportVerification;
}

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const maxTests = 10_000, maxNodes = 200_000;

/**
 * The offline enumeration a unit/integration runner image writes before execution: the
 * identity of every test the approved bundle contains, hashed the way `junitTestIdentity`
 * hashes an executed case, so a report is verified against the approved suite and no test
 * title reaches the control plane.
 */
export const inventoryFormat = 'graphyard-inventory-v1';
export const genericInventory = z.object({
  format: z.literal(inventoryFormat),
  tests: z.array(z.object({ id: hex64 }).strict()).max(maxTests),
  overflow: z.boolean(),
}).strict();
/** `suitePath` is every enclosing `testsuite` name from the root, joined with `/`. */
export const junitTestIdentity = (suitePath: string, classname: string, name: string) =>
  createHash('sha256').update([suitePath, classname, name].join('\u001f')).digest('hex');

// --- A small strict XML reader ---------------------------------------------------------
// JUnit files are written by test tools, not by candidates, but they still come from the
// execution boundary and are parsed by a trusted collector: no DOCTYPE, no entity
// declarations, no external references, bounded size and node counts, and any construct
// this reader does not understand is a refusal rather than a guess.
type XmlNode = { name: string; attributes: Record<string, string>; children: XmlNode[]; text: string };
const xmlName = /^[A-Za-z_][\w.:-]*/;
const decodeText = (value: string) => !value.includes('&') ? value : value.replace(/&(#x[0-9a-fA-F]{1,6};|#[0-9]{1,7};|lt;|gt;|amp;|quot;|apos;)?/g, (_, entity?: string) => {
  if (!entity) throw new Error('Unsupported XML entity reference');
  if (entity[0] === '#') { const code = entity[1] === 'x' ? parseInt(entity.slice(2, -1), 16) : parseInt(entity.slice(1, -1), 10); if (!Number.isFinite(code) || code > 0x10ffff) throw new Error('XML character reference is out of range'); return String.fromCodePoint(code); }
  return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[entity.slice(0, -1)]!;
});
export function parseXml(input: string): XmlNode {
  if (input.includes('<!DOCTYPE') || input.includes('<!ENTITY') || /<!(?!\[CDATA\[|--)/.test(input)) throw new Error('XML document type and entity declarations are refused');
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null, nodes = 0, at = 0;
  const current = () => stack.at(-1);
  const text = (chunk: string) => { const node = current(); if (!node) { if (chunk.trim()) throw new Error('XML text outside the document element'); return; } node.text += chunk; };
  while (at < input.length) {
    const open = input.indexOf('<', at);
    if (open < 0) { text(decodeText(input.slice(at))); break; }
    if (open > at) text(decodeText(input.slice(at, open)));
    if (input.startsWith('<?', open)) { const end = input.indexOf('?>', open); if (end < 0) throw new Error('Unterminated XML processing instruction'); at = end + 2; continue; }
    if (input.startsWith('<!--', open)) { const end = input.indexOf('-->', open); if (end < 0) throw new Error('Unterminated XML comment'); at = end + 3; continue; }
    if (input.startsWith('<![CDATA[', open)) { const end = input.indexOf(']]>', open); if (end < 0) throw new Error('Unterminated CDATA section'); text(input.slice(open + 9, end)); at = end + 3; continue; }
    if (input.startsWith('</', open)) {
      const end = input.indexOf('>', open); if (end < 0) throw new Error('Unterminated XML end tag');
      const name = input.slice(open + 2, end).trim(), node = stack.pop();
      if (!node || node.name !== name) throw new Error(`Mismatched XML end tag ${JSON.stringify(name)}`);
      at = end + 1; continue;
    }
    // A start tag. Attribute values may contain '>' so the tag end is found by scanning.
    let cursor = open + 1;
    const nameMatch = xmlName.exec(input.slice(cursor)); if (!nameMatch) throw new Error('Malformed XML start tag');
    const node: XmlNode = { name: nameMatch[0], attributes: {}, children: [], text: '' };
    cursor += nameMatch[0].length;
    let selfClosing = false;
    for (;;) {
      const rest = input.slice(cursor);
      const space = /^\s+/.exec(rest); if (space) { cursor += space[0].length; continue; }
      if (rest.startsWith('/>')) { selfClosing = true; cursor += 2; break; }
      if (rest.startsWith('>')) { cursor += 1; break; }
      const attribute = /^([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
      if (!attribute) throw new Error(`Malformed XML attribute in <${node.name}>`);
      if (attribute[1] in node.attributes) throw new Error(`Duplicate XML attribute ${attribute[1]} in <${node.name}>`);
      node.attributes[attribute[1]] = decodeText(attribute[2] ?? attribute[3] ?? '');
      cursor += attribute[0].length;
    }
    if (++nodes > maxNodes) throw new Error('XML document exceeds the supported element count');
    const parent = current();
    if (parent) parent.children.push(node);
    else if (root) throw new Error('XML document has more than one document element');
    else root = node;
    if (!selfClosing) stack.push(node);
    at = cursor;
  }
  if (stack.length) throw new Error(`Unterminated XML element <${stack.at(-1)!.name}>`);
  if (!root) throw new Error('XML document has no document element');
  return root;
}

// --- JUnit XML ------------------------------------------------------------------------
type JunitStatus = 'passed' | 'failed' | 'error' | 'skipped';
export const junitReport = z.object({
  format: z.literal('junit-xml-v1'),
  tests: z.array(z.object({ id: hex64, status: z.enum(['passed', 'failed', 'error', 'skipped']), retried: z.boolean(), timeMs: z.number().int().min(0).nullable() }).strict()).max(maxTests),
  suites: z.number().int().min(0),
  counts: z.object({ tests: z.number().int().min(0), failures: z.number().int().min(0), errors: z.number().int().min(0), skipped: z.number().int().min(0) }).strict(),
  /** Whether every count a suite declared agrees with the cases it actually contains. */
  consistent: z.boolean(),
  overflow: z.boolean(),
}).strict();
export type JunitReport = z.infer<typeof junitReport>;
const ignoredSuiteChildren = new Set(['properties', 'system-out', 'system-err']);
const ignoredCaseChildren = new Set(['properties', 'system-out', 'system-err']);
const retryMarkers = new Set(['flakyFailure', 'flakyError', 'rerunFailure', 'rerunError']);
const declaredCount = (node: XmlNode, attribute: string) => {
  if (!(attribute in node.attributes)) return null;
  const value = Number(node.attributes[attribute]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`JUnit ${attribute} count is not a non-negative integer`);
  return value;
};
/**
 * Normalise a JUnit XML document. Only structure survives: test identities are hashed,
 * and messages, stack traces, properties and captured stdio are discarded here so they
 * can neither be published nor influence the verdict. `<testsuites>`, a bare
 * `<testsuite>` root, nested suites and the direct `<testcase>` children Node's reporter
 * writes under `<testsuites>` are accepted; any other element is refused by name.
 */
export function normaliseJunit(input: string): JunitReport {
  const root = parseXml(input);
  if (root.name !== 'testsuites' && root.name !== 'testsuite') throw new Error(`Unsupported report root element <${root.name}>; expected a JUnit <testsuites> or <testsuite> document`);
  const tests: JunitReport['tests'][number][] = [];
  const seen = new Set<string>();
  let suites = 0, consistent = true, overflow = false;
  const counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  function testcase(node: XmlNode, suitePath: string) {
    if (!('name' in node.attributes)) throw new Error('JUnit testcase without a name attribute');
    const id = junitTestIdentity(suitePath, node.attributes.classname ?? '', node.attributes.name);
    let status: JunitStatus = 'passed', retried = false;
    for (const child of node.children) {
      if (child.name === 'error') status = 'error';
      else if (child.name === 'failure') { if (status !== 'error') status = 'failed'; }
      else if (child.name === 'skipped') { if (status === 'passed') status = 'skipped'; }
      else if (retryMarkers.has(child.name)) retried = true;
      else if (!ignoredCaseChildren.has(child.name)) throw new Error(`Unsupported JUnit testcase element <${child.name}>`);
    }
    // Node's reporter also flags the outcome as attributes on the case itself.
    if ('failure' in node.attributes && status === 'passed') status = 'failed';
    if ('error' in node.attributes && status !== 'error') status = 'error';
    const time = node.attributes.time === undefined ? null : Number(node.attributes.time);
    if (time !== null && !(Number.isFinite(time) && time >= 0)) throw new Error('JUnit testcase time is not a non-negative number');
    if (tests.length >= maxTests) { overflow = true; return { status, retried }; }
    if (seen.has(id)) retried = true; seen.add(id);
    tests.push({ id, status, retried, timeMs: time === null ? null : Math.round(time * 1000) });
    return { status, retried };
  }
  function suite(node: XmlNode, path: string[]) {
    if (path.length > 20) throw new Error('JUnit suites nest deeper than supported');
    suites++;
    const own = { tests: 0, failures: 0, errors: 0, skipped: 0 };
    const suitePath = path.join('/');
    for (const child of node.children) {
      if (child.name === 'testsuite') suite(child, [...path, child.attributes.name ?? '']);
      else if (child.name === 'testcase') {
        const { status } = testcase(child, suitePath);
        own.tests++; if (status === 'failed') own.failures++; if (status === 'error') own.errors++; if (status === 'skipped') own.skipped++;
      } else if (!ignoredSuiteChildren.has(child.name)) throw new Error(`Unsupported JUnit suite element <${child.name}>`);
    }
    for (const key of ['tests', 'failures', 'errors', 'skipped'] as const) {
      const declared = declaredCount(node, key);
      if (declared !== null && declared !== own[key]) consistent = false;
    }
    counts.tests += own.tests; counts.failures += own.failures; counts.errors += own.errors; counts.skipped += own.skipped;
  }
  if (root.name === 'testsuite') suite(root, [root.attributes.name ?? '']);
  else {
    const direct = { tests: 0, failures: 0, errors: 0, skipped: 0 };
    for (const child of root.children) {
      if (child.name === 'testsuite') suite(child, [child.attributes.name ?? '']);
      else if (child.name === 'testcase') {
        const { status } = testcase(child, '');
        direct.tests++; if (status === 'failed') direct.failures++; if (status === 'error') direct.errors++; if (status === 'skipped') direct.skipped++;
      } else throw new Error(`Unsupported JUnit element <${child.name}> under <testsuites>`);
    }
    counts.tests += direct.tests; counts.failures += direct.failures; counts.errors += direct.errors; counts.skipped += direct.skipped;
    for (const key of ['tests', 'failures', 'errors', 'skipped'] as const) {
      const declared = declaredCount(root, key);
      if (declared !== null && declared !== counts[key]) consistent = false;
    }
  }
  return junitReport.parse({ format: 'junit-xml-v1', tests, suites, counts, consistent, overflow });
}

function verifyJunit(inventoryInput: unknown, reportInput: unknown): ReportVerification {
  const inventory = genericInventory.parse(inventoryInput), report = junitReport.parse(reportInput);
  const reasons: string[] = [];
  const declared = new Set(inventory.tests.map(t => t.id));
  if (!declared.size || declared.size !== inventory.tests.length || inventory.overflow) reasons.push('Approved test inventory is missing or inconsistent');
  const executed = new Set(report.tests.map(t => t.id));
  if (report.tests.length !== executed.size || executed.size !== declared.size || report.tests.some(t => !declared.has(t.id) || t.retried)) reasons.push('Tests are missing, duplicated, unexpected or retried');
  if (!report.consistent) reasons.push('Suite counts declared by the report disagree with the test cases it contains');
  if (report.overflow) reasons.push('The report exceeds the supported test count; behavior was not completely observed');
  if (report.tests.some(t => t.status !== 'passed')) reasons.push('Behavior failed, errored, was skipped or not completely observed');
  return { passed: reasons.length === 0, inventoryComplete: !reasons.some(r => /inventory|missing|duplicated|disagree|exceeds/.test(r)),
    executed: report.tests.filter(t => t.status !== 'skipped').length, skipped: report.tests.filter(t => t.status === 'skipped').length, reasons };
}

const json = (document: unknown): ParsedArtifact['published'] => ({ bytes: Buffer.from(JSON.stringify(document)), mediaType: 'application/json' });
const parseJson = (bytes: Buffer) => { try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Artifact is not a JSON document'); } };

const playwright: ReportAdapter = {
  format: 'graphyard-playwright-v1', kind: 'e2e',
  producers: [{ name: '@playwright/test', versions: '1.63.x through the packaged runner image and its built-in reporter' }],
  artifacts: { inventory: { file: 'inventory.json', mediaType: 'application/json' }, report: { file: 'report.json', mediaType: 'application/json' } },
  proves: [
    'Every test the approved bundle enumerates executed exactly once, with no retry, and passed',
    'No step failed and no reporter error, interruption or overflow occurred',
    'The executed inventory is identical to the inventory enumerated offline before execution',
  ],
  observed: [
    'The inventory is enumerated by the pinned image with no network, so the target cannot shape it',
    'Both files are measured and signed by the host attestor before the collector reads them',
    'Test identities are hashes; titles, step names, error text and stdio never enter the report',
  ],
  notProven: [
    'Which artifact served the traffic: target attribution is a separate independent measurement',
    'That the assertions are meaningful; bundle approval is the operator\'s review of them',
  ],
  failureSemantics: {
    failed: 'behavior failed', skipped: 'refused: required inventory was not executed', timedOut: 'refused', interrupted: 'refused',
    retry: 'refused: a pass after a retry retains the earlier failure', 'expected-failing test': 'refused', overflow: 'refused: not completely observed',
    'unknown format': 'refused before verification', 'missing file': 'refused: artifact missing at the execution boundary',
  },
  parse(kind, bytes) { const document = runnerReport.parse(parseJson(bytes)); void kind; return { document, published: { bytes, mediaType: 'application/json' } }; },
  verify(inventory, report) { const v = verifyRunnerReport(inventory, report); return { passed: v.passed, inventoryComplete: v.inventoryComplete, executed: v.executed, skipped: v.skipped, reasons: v.reasons }; },
};

const junit: ReportAdapter = {
  format: 'junit-xml-v1', kind: 'unit-integration',
  producers: [
    { name: 'node --test --test-reporter=junit', versions: 'Node.js 20.x–24.x' },
    { name: 'pytest --junitxml', versions: 'pytest 7.x–8.x (junit_family=xunit2, the default)' },
    { name: 'jest-junit', versions: '16.x' },
    { name: 'Maven Surefire / Failsafe XML', versions: '3.x' },
    { name: 'go-junit-report', versions: 'v2' },
  ],
  artifacts: { inventory: { file: 'inventory.json', mediaType: 'application/json' }, report: { file: 'report.xml', mediaType: 'application/xml' } },
  proves: [
    'Every identity in the offline inventory appears exactly once in the report as passed, with no failure, error, skip or rerun',
    'Suite counts declared by the producer agree with the cases it wrote; a report that disagrees with itself is refused',
  ],
  observed: [
    `The inventory is a ${inventoryFormat} document the pinned image writes offline before execution; this adapter verifies against it but does not observe the enumeration itself`,
    'Both files are measured and signed by the host attestor before the collector reads them',
    'Only structure is published: identities are hashes, and messages, stack traces, properties and captured stdio are discarded at parse time and never uploaded',
  ],
  notProven: [
    'Which artifact served the traffic: unit and integration reports carry no target identity, so the collector\'s independent attribution dimension still decides that',
    'That a test exercised a deployed target at all; a unit suite may pass without touching it',
    'Anything a producer outside the listed versions writes; its output may parse and still be refused as unsupported structure',
  ],
  failureSemantics: {
    failure: 'behavior failed', error: 'behavior failed (error)', skipped: 'refused: required inventory was not executed',
    'flakyFailure/rerunFailure/duplicate case': 'refused as a retry', 'count mismatch': 'refused: inconsistent report',
    'DOCTYPE, entity or unknown element': 'refused before verification', 'unknown root element': 'refused: not a JUnit document',
    'missing inventory or report': 'refused: artifact missing at the execution boundary',
  },
  parse(kind, bytes) {
    if (kind === 'inventory') { const document = genericInventory.parse(parseJson(bytes)); return { document, published: { bytes, mediaType: 'application/json' } }; }
    const document = normaliseJunit(bytes.toString('utf8'));
    return { document, published: json(document) };
  },
  verify: verifyJunit,
};

export const reportAdapters: Record<ReportFormat, ReportAdapter> = { 'graphyard-playwright-v1': playwright, 'junit-xml-v1': junit };
/** The adapter a pinned format names. Anything else is a visible refusal, never a fallback. */
export function reportAdapter(format: unknown): ReportAdapter {
  if (typeof format !== 'string' || !(format in reportAdapters)) throw new Error(`Unsupported report format ${JSON.stringify(format)}; supported formats: ${reportFormats.join(', ')}`);
  return reportAdapters[format as ReportFormat];
}
/** The published contract of every adapter, for `graphyard runner adapters` and the docs. */
export const adapterContracts = () => reportFormats.map(format => {
  const { parse, verify, ...contract } = reportAdapters[format]; void parse; void verify; return contract;
});
