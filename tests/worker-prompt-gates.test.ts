import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workerFastGates, workerFastGatesSentence, workerPrompt } from '../src/master/dispatch.js';

// GY-1797: the fast mechanical gates — the module and docs budget tests, the docs growth and
// glossary gates, the wall-clock bomb scan, the CI shard map and the docs page checker — each run
// locally in seconds, and each is a check CI fails a whole rework round on when a worker ships
// past it. The worker request now names them, extending the repository's standing before-push
// discipline (the sync instruction: run `sync GY-N` before every push) and sitting before the
// request's complete instruction, so a budget or page-invariant failure is fixed in the session,
// not in a CI round. The list is one exported constant beside the prompt (dispatch.ts
// workerFastGates), and the documentation (docs/coordination.md) reads the same list. One case per
// proof: unit:worker-request-names-fast-gates proves AC-1, unit:fast-gates-exist proves AC-2.

const root = fileURLToPath(new URL('..', import.meta.url));
const render = (dependencies: Parameters<typeof workerPrompt>[4] = null, maps: Parameters<typeof workerPrompt>[8] = null) =>
  workerPrompt({ cliPath: '/bin/graphyard.mjs' }, { key: 'GY-1', title: 'Fast gates' }, { principal: 'graphyard-test-1' }, 1, dependencies, null, null, null, maps);
const gatesIn = (text: string) => [...workerFastGates.tests, ...workerFastGates.scripts].filter(gate => text.includes(gate));

test('unit:worker-request-names-fast-gates — the request names the fast mechanical gates and their one command line, after the sync instruction and before the complete instruction, and an input that adds nothing leaves the request byte-identical', () => {
  const request = render();
  // The request carries the sentence and names every gate through the one command line the
  // constant builds: the test files as one `npx tsx --test` command, each script on its own.
  assert.ok(request.includes(workerFastGatesSentence), 'the request carries the fast-gates sentence');
  assert.ok(request.includes(`npx tsx --test ${workerFastGates.tests.join(' ')}`), 'the test gates run as one command line');
  for (const script of workerFastGates.scripts) assert.ok(request.includes(`node ${script}`), `the request names the script command for ${script}`);
  assert.deepEqual(gatesIn(request), [...workerFastGates.tests, ...workerFastGates.scripts], 'the request names every gate in the constant');
  // Position: after the sync instruction — the before-push discipline the repository's standing
  // instructions state ("Run `sync GY-N` before every push") and this sentence extends ("fix what
  // they name before pushing") — and before the complete instruction ("submit it with complete as
  // your last action"), so the gates run in the session, before the push and the submission.
  assert.match(readFileSync(`${root}AGENTS.md`, 'utf8'), /Run `sync GY-N` before every push\./, 'the standing sync instruction the sentence extends');
  const gates = request.indexOf(workerFastGatesSentence);
  const complete = request.indexOf('submit it with complete as your last action');
  assert.ok(gates >= 0 && gates < complete, 'the gates sentence sits before the complete instruction');
  // Nothing else in the request changed: the sentence is the one addition, sitting between the
  // pre-edit status instruction and the worktree instruction that follows it.
  assert.ok(request.includes(`Run node /bin/graphyard.mjs status GY-1 before editing. ${workerFastGatesSentence}Work only in the current assigned worktree`), 'the sentence is the one addition after the pre-edit instruction');
  // Purity, as today: the request is a pure function of its inputs, and an input that adds
  // nothing adds nothing to the request.
  assert.equal(render(), request, 'the same input renders byte-identical');
  assert.equal(render({ shared: [] }), request, 'empty dependencies add nothing');
  assert.equal(render(null, []), request, 'empty verification maps add nothing');
  // An input that adds sections adds the sentence once, never a second copy.
  const withSections = workerPrompt(
    { cliPath: '/bin/graphyard.mjs', repository: 'owner/project' },
    { key: 'GY-1', title: 'Fast gates', plannedFiles: ['src/x.ts'], documentation: { id: 'DOCS', paths: ['docs/'], text: 'Documentation reflects this change', changelog: null } },
    { principal: 'graphyard-test-1' }, 2,
    { shared: [{ name: 'node_modules', source: '/opt/graphyard/node_modules', how: 'reachable' }] },
  );
  assert.equal(withSections.split(workerFastGatesSentence).length - 1, 1, 'the sentence appears exactly once however much else the input adds');
  assert.deepEqual(gatesIn(withSections), [...workerFastGates.tests, ...workerFastGates.scripts], 'every gate is still named once');
});

test('unit:fast-gates-exist — the gate list is one exported constant that names only test files and scripts present in the repository, and the docs read the same list', () => {
  // The constant is the one list: every entry is a test file or script the repository carries.
  const gates = [...workerFastGates.tests, ...workerFastGates.scripts];
  assert.ok(gates.length >= 2, 'the constant names the test gates and the docs checker');
  for (const gate of gates) assert.ok(existsSync(`${root}${gate}`), `${gate} exists in the repository`);
  // The prompt's sentence is built from the constant, so it can never drift from this list.
  assert.equal(workerFastGatesSentence.includes(`npx tsx --test ${workerFastGates.tests.join(' ')}`), true, 'the sentence runs the test gates as one command');
  // The docs read the same list: docs/coordination.md names each gate where it states the
  // worker's pre-push discipline.
  const coordination = readFileSync(`${root}docs/coordination.md`, 'utf8');
  for (const gate of gates) assert.ok(coordination.includes(gate), `docs/coordination.md names ${gate}`);
});
