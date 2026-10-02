import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { adapterContracts, genericInventory, inventoryFormat, junitTestIdentity, normaliseJunit, parseXml, reportAdapter, reportAdapters, reportFormats } from '../src/report-adapters.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const run = promisify(execFile);
// Node's runner marks its own children; a nested `--test` under that mark skips every file.
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST')));
const fixture = (name: string) => readFile(resolve('tests/fixtures/reports', name));
const inventoryFor = (xml: string) => ({ format: inventoryFormat, tests: normaliseJunit(xml).tests.map(t => ({ id: t.id })), overflow: false });
const junit = reportAdapters['junit-xml-v1'];
const markers = ['private-property-marker', 'private-value-marker', 'private-error-marker', 'private-stdout-marker', 'private-sku-marker', 'private-stack-marker', 'ORDERS_API_KEY', 'test_create_order', 'createsAnOrder', 'creates an order'];

test('every adapter publishes a complete contract and unknown formats are refused by name', () => {
  for (const contract of adapterContracts()) {
    assert.ok(reportFormats.includes(contract.format));
    assert.ok(contract.producers.length && contract.producers.every(p => p.name && p.versions));
    for (const list of [contract.proves, contract.observed, contract.notProven]) assert.ok(list.length >= 2);
    assert.ok(Object.keys(contract.failureSemantics).length >= 5);
    assert.ok(!Object.values(contract.failureSemantics).some(v => /\bpass(?:es|ed)?\b/.test(v) && !/refused|retains/.test(v)), 'no failure classification yields a pass');
    assert.equal(contract.artifacts.inventory.file, 'inventory.json');
    assert.ok(!('parse' in contract) && !('verify' in contract));
  }
  for (const unknown of ['junit-xml-v2', 'nunit-3', '', undefined, null, 42, { format: 'junit-xml-v1' }]) assert.throws(() => reportAdapter(unknown), /Unsupported report format/);
});

test('JUnit contract fixtures from real producers normalise, verify and publish only structure', async () => {
  for (const name of ['pytest-8.xml', 'jest-junit-16.xml', 'surefire-3.xml', 'go-junit-report-2.xml']) {
    const bytes = await fixture(name);
    const parsed = junit.parse('report', bytes);
    const report = parsed.document as ReturnType<typeof normaliseJunit>;
    assert.equal(report.consistent, true, name); assert.equal(report.overflow, false, name);
    assert.ok(report.tests.length >= 2, name); assert.ok(report.tests.every(t => t.status === 'passed' && !t.retried && /^[a-f0-9]{64}$/.test(t.id)), name);
    const verified = junit.verify(inventoryFor(bytes.toString('utf8')), report);
    assert.deepEqual(verified, { passed: true, inventoryComplete: true, executed: report.tests.length, skipped: 0, reasons: [] }, name);
    // The published projection is JSON, and nothing a producer wrote in the clear survives.
    assert.equal(parsed.published.mediaType, 'application/json');
    const published = parsed.published.bytes.toString('utf8');
    assert.deepEqual(JSON.parse(published), report);
    for (const marker of markers) assert.ok(!published.includes(marker), `${name} leaked ${marker}`);
  }
});

test('JUnit failures, errors, skips, reruns, inconsistent counts and unknown documents are refused, never passed', async () => {
  const failed = normaliseJunit((await fixture('pytest-8-failed.xml')).toString('utf8'));
  assert.deepEqual(failed.tests.map(t => t.status), ['failed', 'error', 'skipped']);
  assert.deepEqual(failed.counts, { tests: 3, failures: 1, errors: 1, skipped: 1 }); assert.equal(failed.consistent, true);
  const inventory = { format: inventoryFormat, tests: failed.tests.map(t => ({ id: t.id })), overflow: false };
  const verdict = junit.verify(inventory, failed);
  assert.equal(verdict.passed, false); assert.equal(verdict.inventoryComplete, true);
  assert.equal(verdict.executed, 2); assert.equal(verdict.skipped, 1);
  assert.match(verdict.reasons.join(';'), /failed, errored, was skipped/);
  for (const marker of markers) assert.ok(!JSON.stringify(failed).includes(marker));

  const rerun = normaliseJunit((await fixture('surefire-3-rerun.xml')).toString('utf8'));
  assert.equal(rerun.tests[0].retried, true);
  assert.match(junit.verify({ format: inventoryFormat, tests: rerun.tests.map(t => ({ id: t.id })), overflow: false }, rerun).reasons.join(';'), /retried/);

  const inconsistent = normaliseJunit((await fixture('inconsistent-counts.xml')).toString('utf8'));
  assert.equal(inconsistent.consistent, false);
  const inconsistentVerdict = junit.verify({ format: inventoryFormat, tests: inconsistent.tests.map(t => ({ id: t.id })), overflow: false }, inconsistent);
  assert.equal(inconsistentVerdict.passed, false); assert.equal(inconsistentVerdict.inventoryComplete, false);
  assert.match(inconsistentVerdict.reasons.join(';'), /disagree/);

  await assert.rejects(async () => normaliseJunit((await fixture('nunit-3.xml')).toString('utf8')), /Unsupported report root element <test-run>/);
  await assert.rejects(async () => normaliseJunit((await fixture('doctype.xml')).toString('utf8')), /document type and entity declarations are refused/);
  assert.throws(() => normaliseJunit('<testsuite name="x" tests="1"><testcase name="a"><attachment path="/tmp/x"/></testcase></testsuite>'), /Unsupported JUnit testcase element <attachment>/);
  assert.throws(() => normaliseJunit('<testsuite name="x"><testcase classname="c"/></testsuite>'), /without a name attribute/);
  assert.throws(() => normaliseJunit('<testsuite name="x" tests="one"><testcase name="a"/></testsuite>'), /not a non-negative integer/);
  assert.throws(() => normaliseJunit('<testsuite name="x"><testcase name="&external;"/></testsuite>'), /Unsupported XML entity reference/);
  assert.throws(() => normaliseJunit('<testsuite name="x"><testcase name="a"></testsuite>'), /Mismatched XML end tag/);
  assert.throws(() => normaliseJunit('{"format":"graphyard-playwright-v1"}'), /outside the document element/);
  assert.throws(() => junit.parse('report', Buffer.from('<testsuites/><testsuite/>')), /more than one document element/);
});

test('JUnit verification binds execution to the approved inventory identity for identity', () => {
  const a = junitTestIdentity('orders', 'orders', 'creates an order'), b = junitTestIdentity('orders', 'orders', 'cancels an order');
  const report = normaliseJunit('<testsuite name="orders" tests="2"><testcase classname="orders" name="creates an order"/><testcase classname="orders" name="cancels an order"/></testsuite>');
  assert.deepEqual(report.tests.map(t => t.id), [a, b]);
  const inventory = { format: inventoryFormat, tests: [{ id: a }, { id: b }], overflow: false };
  assert.equal(junit.verify(inventory, report).passed, true);
  // Missing, extra, duplicated and overflowing inventories all refuse, and none is complete.
  for (const changed of [{ tests: [{ id: a }] }, { tests: [{ id: a }, { id: b }, { id: junitTestIdentity('orders', 'orders', 'refunds') }] }, { tests: [{ id: a }, { id: a }] }, { tests: [] }, { overflow: true }]) {
    const verdict = junit.verify({ ...inventory, ...changed }, report);
    assert.equal(verdict.passed, false); assert.equal(verdict.inventoryComplete, false);
  }
  // The same case executed twice is a retry, not two passes.
  const twice = normaliseJunit('<testsuite name="orders" tests="2"><testcase classname="orders" name="creates an order"/><testcase classname="orders" name="creates an order"/></testsuite>');
  assert.equal(twice.tests[1].retried, true);
  // Suite path is part of identity: the same case name in another suite is another test.
  assert.notEqual(junitTestIdentity('orders', 'orders', 'creates an order'), junitTestIdentity('billing', 'orders', 'creates an order'));
  assert.throws(() => junit.verify({ format: 'graphyard-playwright-v1' }, report));
  assert.throws(() => junit.verify(inventory, { ...report, tests: [{ ...report.tests[0], extra: true }] }));
  assert.throws(() => junit.parse('inventory', Buffer.from(JSON.stringify({ format: inventoryFormat, tests: [{ id: 'not-a-digest' }], overflow: false }))));
  assert.deepEqual(genericInventory.parse(inventory), inventory);
});

test('the Playwright adapter still accepts only the built-in reporter structure, and refuses JUnit bytes', async () => {
  const playwright = reportAdapters['graphyard-playwright-v1'];
  const id = 'a'.repeat(64);
  const inventory = { format: 'graphyard-playwright-v1', declared: [{ id, expected: 'passed', location: { file: 'fixture.spec.ts', line: 1, column: 1 } }], executions: [], steps: [], errors: 0, overflow: false, status: 'passed' };
  const bytes = Buffer.from(JSON.stringify(inventory));
  const parsed = playwright.parse('inventory', bytes);
  assert.equal(parsed.published.bytes, bytes, 'the reporter output is already minimal and is published as read');
  assert.deepEqual(playwright.verify(inventory, { ...inventory, executions: [{ id, status: 'passed', retry: 0 }] }), { passed: true, inventoryComplete: true, executed: 1, skipped: 0, reasons: [] });
  const junitBytes = await fixture('pytest-8.xml');
  assert.throws(() => playwright.parse('report', junitBytes), /not a JSON document/);
  assert.throws(() => playwright.parse('report', Buffer.from(JSON.stringify({ format: 'junit-xml-v1', tests: [], suites: 0, counts: { tests: 0, failures: 0, errors: 0, skipped: 0 }, consistent: true, overflow: false }))));
  assert.throws(() => junit.parse('report', bytes), /outside the document element/);
});

test('a real node:test JUnit report verifies against an offline inventory and a broken assertion fails with no leaked text', async () => {
  const root = await temporaryDirectory('junit');
  try {
    const spec = join(root, 'orders.test.mjs');
    const write = (assertion: string) => writeFile(spec, `import { test, describe } from 'node:test'; import assert from 'node:assert';
describe('orders private-suite-marker', () => { test('creates an order', () => assert.equal(1, 1)); test('cancels an order', () => { console.log('private-stdout-marker'); ${assertion} }); });`);
    const capture = async () => { try { return (await run(process.execPath, ['--test', '--test-reporter=junit', spec], { env: childEnv, timeout: 60_000 })).stdout; } catch (error: any) { return String(error.stdout); } };
    await write('assert.equal(2, 2);');
    const passing = junit.parse('report', Buffer.from(await capture()));
    const report = passing.document as ReturnType<typeof normaliseJunit>;
    assert.equal(report.tests.length, 2); assert.equal(report.consistent, true);
    const inventory = { format: inventoryFormat, tests: report.tests.map(t => ({ id: t.id })), overflow: false };
    assert.equal(junit.verify(inventory, report).passed, true);
    await write("assert.equal('private-expected-marker', 'broken');");
    const broken = junit.parse('report', Buffer.from(await capture()));
    const verdict = junit.verify(inventory, broken.document);
    assert.equal(verdict.passed, false); assert.equal(verdict.inventoryComplete, true);
    const published = broken.published.bytes.toString('utf8');
    for (const marker of ['private-suite-marker', 'private-stdout-marker', 'private-expected-marker', 'orders.test.mjs', 'cancels an order']) assert.ok(!published.includes(marker), marker);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the XML reader is bounded and refuses what it does not understand', () => {
  assert.deepEqual(parseXml('<a x="1" y=\'2\'><b/>text &amp; &#65;&#x42;</a>').children.length, 1);
  assert.equal(parseXml('<a>&lt;&gt;&quot;&apos;</a>').text, '<>"\'');
  assert.equal(parseXml('<a><![CDATA[<raw>]]><!-- c --></a>').text, '<raw>');
  assert.throws(() => parseXml('<a x="1" x="2"/>'), /Duplicate XML attribute/);
  assert.throws(() => parseXml('<a>&#x110000;</a>'), /out of range/);
  assert.throws(() => parseXml('text<a/>'), /outside the document element/);
  assert.throws(() => parseXml('<a'), /Malformed XML attribute|Unterminated/);
  assert.throws(() => parseXml('<a><?pi'), /Unterminated XML processing instruction/);
  assert.throws(() => parseXml('<a><![CDATA[x'), /Unterminated CDATA/);
  assert.throws(() => parseXml(''), /no document element/);
  const wide = `<testsuite name="s" tests="10001">${'<testcase classname="c" name="n"/>'.repeat(10_001)}</testsuite>`;
  const overflowed = normaliseJunit(wide);
  assert.equal(overflowed.overflow, true); assert.equal(overflowed.tests.length, 10_000);
  assert.equal(junit.verify({ format: inventoryFormat, tests: overflowed.tests.map(t => ({ id: t.id })), overflow: false }, overflowed).passed, false);
  assert.throws(() => parseXml(`<a>${'<b/>'.repeat(200_001)}</a>`), /element count/);
});
