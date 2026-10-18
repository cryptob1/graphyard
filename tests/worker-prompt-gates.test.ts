import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerPrompt } from '../src/master/dispatch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workerBeforePushSection, workerFastGates, workerFastGatesCommand, workerFastGatesPresent, workerFastGatesSentence, workerSyncSentence } from '../src/master/worker-fast-gates.js';

// GY-1797: the fast mechanical gates — the module and docs budget tests, the docs growth and
// glossary gates, the wall-clock bomb scan, the CI shard map and the docs page checker — each run
// locally in seconds, and each is a check CI fails a whole rework round on when a worker ships
// past it. The worker request now states its before-push discipline in order: the sync
// instruction (run `sync GY-N` before submitting), then the gates as one command line, then the
// request's standing complete instruction, so a budget or page-invariant failure is fixed in the
// session, not in a CI round. The gates exist only in this repository's tree, so the launcher
// names them only when the checkout it runs from carries every one of them, handing that fact to
// the prompt as an input; a request for any other managed repository renders byte-identical to
// the request as it was before GY-1797. The list is one exported constant in its own module
// (src/master/worker-fast-gates.ts) beside the prompt — dispatch.ts sits within a few lines of its
// 800-line budget, and the item's first attempt merged at 801 and was reverted by the very gate it
// names — and the documentation (docs/coordination.md) reads the same list. One case per proof:
// unit:worker-request-names-fast-gates proves AC-1, unit:fast-gates-exist proves AC-2; the soak
// tests/soak-worker-fast-gates.test.ts drives the same request through the real loop over a day.

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = '/bin/graphyard.mjs';
const gates = [...workerFastGates.tests, ...workerFastGates.scripts];
const gatesIn = (text: string) => gates.filter(gate => text.includes(gate));
const render = (fastGates?: boolean, dependencies?: Parameters<typeof workerPrompt>[4], maps?: Parameters<typeof workerPrompt>[8]) =>
  workerPrompt({ cliPath: cli, ...(fastGates === undefined ? {} : { fastGates }) }, { key: 'GY-1', title: 'Fast gates' }, { principal: 'graphyard-test-1' }, 1, dependencies ?? null, null, null, null, maps ?? null);
const section = workerBeforePushSection(cli, 'GY-1'), sync = workerSyncSentence(cli, 'GY-1');

test('unit:worker-request-names-fast-gates — the request names the fast mechanical gates and their one command line, after the sync instruction and before the complete instruction, and an input that adds nothing leaves the request byte-identical', () => {
  const request = render(true);
  // The request carries the sync instruction and the gates sentence, and the gates run as one
  // command line: the whole list in a single code span, the test files in one harness run chained
  // with `&&` to each script.
  assert.ok(request.includes(sync), 'the request carries the sync instruction');
  assert.match(sync, /^Run node \/bin\/graphyard\.mjs sync GY-1 before submitting: /, 'the sync instruction names the CLI and the item');
  assert.ok(request.includes(workerFastGatesSentence), 'the request carries the fast-gates sentence');
  assert.deepEqual(workerFastGatesSentence.match(/`[^`]*`/g), [`\`${workerFastGatesCommand}\``], 'the sentence names exactly one command line, in one code span');
  assert.ok(request.includes(workerFastGatesCommand), 'the request carries the one command line');
  assert.deepEqual(gatesIn(request), gates, 'the request names every gate in the constant');
  // Order, in the request itself: the sync instruction, then the gates sentence, then the complete
  // instruction ("submit the commit with complete --head as your last action"), so the gates run in the session
  // after the sync and before the push and the submission.
  const syncAt = request.indexOf(sync), gatesAt = request.indexOf(workerFastGatesSentence), completeAt = request.indexOf('--head as your last action');
  assert.ok(syncAt >= 0 && syncAt < gatesAt, 'the gates sentence sits after the sync instruction');
  assert.ok(gatesAt >= 0 && gatesAt < completeAt, 'the gates sentence sits before the complete instruction');
  assert.equal(syncAt + sync.length, gatesAt, 'the gates sentence follows the sync instruction directly');
  assert.equal(request.indexOf('sync GY-1'), syncAt + 'Run node /bin/graphyard.mjs '.length, 'the sync instruction is the first mention of sync');
  // The standing sync rule the request's instruction restates, in this repository's own instructions.
  assert.match(readFileSync(`${root}AGENTS.md`, 'utf8'), /Run `sync GY-N` before submitting\./, 'the standing sync instruction the request now states');
  // Nothing else in the request changed: the section is the one addition, sitting between the
  // pre-edit status instruction and the worktree instruction that follows it.
  assert.ok(request.includes(`Run node ${cli} status GY-1 before editing. ${section}Work only in the current assigned worktree`), 'the section is the one addition after the pre-edit instruction');
  // Purity, as today: the request is a pure function of its inputs, and an input that adds
  // nothing adds nothing to the request.
  assert.equal(render(true), request, 'the same input renders byte-identical');
  assert.equal(render(true, { shared: [] }), request, 'empty dependencies add nothing');
  assert.equal(render(true, null, []), request, 'empty verification maps add nothing');
  // An input that adds sections adds the section once, never a second copy.
  const withSections = workerPrompt(
    { cliPath: cli, repository: 'owner/graphyard', fastGates: true },
    { key: 'GY-1', title: 'Fast gates', plannedFiles: ['src/x.ts'], documentation: { id: 'DOCS', paths: ['docs/'], text: 'Documentation reflects this change', changelog: null } },
    { principal: 'graphyard-test-1' }, 2,
    { shared: [{ name: 'node_modules', source: '/opt/graphyard/node_modules', how: 'reachable' }] },
  );
  assert.equal(withSections.split(workerFastGatesSentence).length - 1, 1, 'the sentence appears exactly once however much else the input adds');
  assert.equal(withSections.split(sync).length - 1, 1, 'the sync instruction appears exactly once');
  assert.deepEqual(gatesIn(withSections), gates, 'every gate is still named once');
  // A checkout that carries none of these files — any other managed repository — names no gate,
  // and its request is byte-identical to the request as it rendered before GY-1797: this request
  // minus the section.
  const other = render(false);
  assert.equal(other, request.replace(section, ''), "another repository's request is byte-identical to the pre-GY-1797 request");
  assert.ok(!other.includes('fast gates') && !other.includes(' sync GY-1') && gatesIn(other).length === 0, "another repository's request names no gate and no sync");
  assert.ok(other.includes('before editing. Work only in the current assigned worktree'), "another repository's request keeps the pre-edit instruction with its one space");
  assert.equal(render(), other, 'a request whose launcher said nothing of the gates renders as before');
  assert.equal(workerPrompt({ cliPath: cli, repository: 'owner/graphyard' }, { key: 'GY-1', title: 'Fast gates' }, { principal: 'graphyard-test-1' }, 1), other, 'the repository name alone adds nothing: the gates are an input the launcher reads from its checkout');
});

test('unit:fast-gates-exist — the gate list is one exported constant that names only test files and scripts present in the repository, and the docs read the same list', async () => {
  // The constant is the one list: every entry is a test file or script the repository carries.
  assert.ok(gates.length >= 2, 'the constant names the test gates and the docs checker');
  for (const gate of gates) assert.ok(existsSync(`${root}${gate}`), `${gate} exists in the repository`);
  for (const gate of workerFastGates.tests) assert.match(gate, /^tests\/[^/]+\.test\.ts$/, `${gate} is a test file of the suite`);
  for (const gate of workerFastGates.scripts) assert.match(gate, /^scripts\/[^/]+\.mjs$/, `${gate} is a script of the repository`);
  // The launcher's rule reads the same list: this checkout carries every gate; a checkout missing
  // any one of them — an empty tree, or one with every gate but the last — carries none.
  assert.ok(workerFastGatesPresent(root), 'this repository carries every gate');
  const empty = await temporaryDirectory('fast-gates');
  assert.ok(!workerFastGatesPresent(empty), 'an empty checkout carries no gate');
  for (const gate of gates.slice(0, -1)) { mkdirSync(dirname(join(empty, gate)), { recursive: true }); writeFileSync(join(empty, gate), ''); }
  assert.ok(!workerFastGatesPresent(empty), 'a checkout missing one gate names none');
  mkdirSync(dirname(join(empty, gates.at(-1)!)), { recursive: true }); writeFileSync(join(empty, gates.at(-1)!), '');
  assert.ok(workerFastGatesPresent(empty), 'a checkout carrying every gate names them');
  // The command and the sentence are built from the constant, so neither can drift from this list.
  assert.equal(workerFastGatesCommand, `node --import tsx tests/helpers/run-tests.ts ${workerFastGates.tests.join(' ')} && ${workerFastGates.scripts.map(script => `node ${script}`).join(' && ')}`, 'the command runs the constant\'s gates as one line');
  // Through the suite's own harness, never a bare `node --test`: the harness reserves the port
  // window every gate's Postgres and ci-shards's nested-run guard need, so the line passes in a
  // bare worker session and a failure it names is one the worker can fix there.
  assert.ok(workerFastGatesCommand.startsWith('node --import tsx tests/helpers/run-tests.ts '), 'the gates run through the reserving harness');
  assert.ok(workerFastGatesSentence.includes(`\`${workerFastGatesCommand}\``), 'the sentence runs the gates as one command line');
  // The constant lives in its own concern module under src/master, within the module budget the
  // gates enforce, and dispatch.ts reads it from there: the list is defined exactly once.
  const module = readFileSync(`${root}src/master/worker-fast-gates.ts`, 'utf8');
  assert.match(module.split('\n')[0], /^\/\/ Concern: .*fast mechanical gates/, 'the module opens with its concern header');
  assert.equal(module.match(/^export const workerFastGates = \{/mg)?.length, 1, 'the module exports the list once');
  const dispatch = readFileSync(`${root}src/master/dispatch.ts`, 'utf8');
  assert.ok(dispatch.includes("from './worker-fast-gates.js'"), 'dispatch.ts imports the gates from the module');
  assert.ok(!dispatch.includes('tests/module-budgets.test.ts'), 'dispatch.ts carries no copy of the list');
  assert.ok(dispatch.includes('fastGates: workerFastGatesPresent(root)'), 'the launcher reads the gates from its checkout once per launch and hands the answer to the prompt');
  // The docs read the same list: docs/coordination.md names each gate where it states the
  // worker's pre-push discipline.
  const coordination = readFileSync(`${root}docs/coordination.md`, 'utf8');
  for (const gate of gates) assert.ok(coordination.includes(gate), `docs/coordination.md names ${gate}`);
});
