import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workerPrompt } from '../src/master/dispatch.js';
import { fastGatesApply, workerFastGates, workerFastGatesCommand, workerFastGatesRepository, workerFastGatesSentence } from '../src/master/worker-fast-gates.js';

// GY-1797: the fast mechanical gates — the module and docs budget tests, the docs growth and
// glossary gates, the wall-clock bomb scan, the CI shard map and the docs page checker — each run
// locally in seconds, and each is a check CI fails a whole rework round on when a worker ships
// past it. The worker request now names them as one command line, extending the repository's
// standing before-push discipline (the sync instruction: run `sync GY-N` before every push) and
// sitting before the request's complete instruction, so a budget or page-invariant failure is
// fixed in the session, not in a CI round. The gates exist only in this repository's tree, so only
// its own requests name them; a request for any other managed repository renders byte-identical to
// the request as it was before GY-1797. The list is one exported constant in its own module
// (src/master/worker-fast-gates.ts) beside the prompt — dispatch.ts sits within a few lines of its
// 800-line budget, and the item's first attempt merged at 801 and was reverted by the very gate it
// names — and the documentation (docs/coordination.md) reads the same list. One case per proof:
// unit:worker-request-names-fast-gates proves AC-1, unit:fast-gates-exist proves AC-2.

const root = fileURLToPath(new URL('..', import.meta.url));
const ownRepository = `owner/${workerFastGatesRepository}`;
const gates = [...workerFastGates.tests, ...workerFastGates.scripts];
const gatesIn = (text: string) => gates.filter(gate => text.includes(gate));
const render = (repository?: string, dependencies?: Parameters<typeof workerPrompt>[4], maps?: Parameters<typeof workerPrompt>[8]) =>
  workerPrompt({ cliPath: '/bin/graphyard.mjs', ...(repository ? { repository } : {}) }, { key: 'GY-1', title: 'Fast gates' }, { principal: 'graphyard-test-1' }, 1, dependencies ?? null, null, null, null, maps ?? null);

test('unit:worker-request-names-fast-gates — the request names the fast mechanical gates and their one command line, after the sync instruction and before the complete instruction, and an input that adds nothing leaves the request byte-identical', () => {
  const request = render(ownRepository);
  // The request carries the sentence, and the gates run as one command line: the whole list in a
  // single code span, the test files in one harness run chained with `&&` to each script.
  assert.ok(request.includes(workerFastGatesSentence), 'the request carries the fast-gates sentence');
  assert.deepEqual(workerFastGatesSentence.match(/`[^`]*`/g), [`\`${workerFastGatesCommand}\``], 'the sentence names exactly one command line, in one code span');
  assert.ok(request.includes(workerFastGatesCommand), 'the request carries the one command line');
  assert.deepEqual(gatesIn(request), gates, 'the request names every gate in the constant');
  // Position: after the sync instruction — the before-push discipline the repository's standing
  // instructions state ("Run `sync GY-N` before every push") and this sentence extends ("fix what
  // they name before pushing") — and before the complete instruction ("submit it with complete as
  // your last action"), so the gates run in the session, before the push and the submission.
  assert.match(readFileSync(`${root}AGENTS.md`, 'utf8'), /Run `sync GY-N` before every push\./, 'the standing sync instruction the sentence extends');
  const gatesAt = request.indexOf(workerFastGatesSentence);
  const complete = request.indexOf('submit it with complete as your last action');
  assert.ok(gatesAt >= 0 && gatesAt < complete, 'the gates sentence sits before the complete instruction');
  // Nothing else in the request changed: the sentence is the one addition, sitting between the
  // pre-edit status instruction and the worktree instruction that follows it.
  assert.ok(request.includes(`Run node /bin/graphyard.mjs status GY-1 before editing. ${workerFastGatesSentence}Work only in the current assigned worktree`), 'the sentence is the one addition after the pre-edit instruction');
  // Purity, as today: the request is a pure function of its inputs, and an input that adds
  // nothing adds nothing to the request.
  assert.equal(render(ownRepository), request, 'the same input renders byte-identical');
  assert.equal(render(ownRepository, { shared: [] }), request, 'empty dependencies add nothing');
  assert.equal(render(ownRepository, null, []), request, 'empty verification maps add nothing');
  // An input that adds sections adds the sentence once, never a second copy.
  const withSections = workerPrompt(
    { cliPath: '/bin/graphyard.mjs', repository: ownRepository },
    { key: 'GY-1', title: 'Fast gates', plannedFiles: ['src/x.ts'], documentation: { id: 'DOCS', paths: ['docs/'], text: 'Documentation reflects this change', changelog: null } },
    { principal: 'graphyard-test-1' }, 2,
    { shared: [{ name: 'node_modules', source: '/opt/graphyard/node_modules', how: 'reachable' }] },
  );
  assert.equal(withSections.split(workerFastGatesSentence).length - 1, 1, 'the sentence appears exactly once however much else the input adds');
  assert.deepEqual(gatesIn(withSections), gates, 'every gate is still named once');
  // Another managed repository carries none of these files, so its request names no gate and is
  // byte-identical to the request as it rendered before GY-1797 — this request minus the sentence.
  const other = render('owner/other-project');
  assert.equal(other, request.replace(workerFastGatesSentence, ''), "another repository's request is byte-identical to the pre-GY-1797 request");
  assert.ok(!other.includes('fast gates') && gatesIn(other).length === 0, "another repository's request names no gate");
  assert.ok(other.includes('before editing. Work only in the current assigned worktree'), "another repository's request keeps the pre-edit instruction with its one space");
  assert.equal(render(), other, 'a request with no repository renders as another repository\'s does');
  // The repository match reads the owner-less name, case-insensitively, and nothing else.
  assert.ok(fastGatesApply('cryptob1/graphyard') && fastGatesApply('Graphyard') && !fastGatesApply('cryptob1/graphyard-docs') && !fastGatesApply(undefined), 'only this repository, under any owner or case, names the gates');
});

test('unit:fast-gates-exist — the gate list is one exported constant that names only test files and scripts present in the repository, and the docs read the same list', () => {
  // The constant is the one list: every entry is a test file or script the repository carries.
  assert.ok(gates.length >= 2, 'the constant names the test gates and the docs checker');
  for (const gate of gates) assert.ok(existsSync(`${root}${gate}`), `${gate} exists in the repository`);
  for (const gate of workerFastGates.tests) assert.match(gate, /^tests\/[^/]+\.test\.ts$/, `${gate} is a test file of the suite`);
  for (const gate of workerFastGates.scripts) assert.match(gate, /^scripts\/[^/]+\.mjs$/, `${gate} is a script of the repository`);
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
  // The docs read the same list: docs/coordination.md names each gate where it states the
  // worker's pre-push discipline.
  const coordination = readFileSync(`${root}docs/coordination.md`, 'utf8');
  for (const gate of gates) assert.ok(coordination.includes(gate), `docs/coordination.md names ${gate}`);
});
