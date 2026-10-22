import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workerPrompt } from '../src/master/dispatch.js';
import { workerBeforePushSection, workerFastGates, workerFastGatesCommand, workerFastGatesSentence, workerSyncSentence } from '../src/master/worker-fast-gates.js';

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
// names. unit:worker-request-names-fast-gates proves the request renders the gates it is told of;
// whether this checkout still carries them is the launcher's reading, not pinned here.

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
    { key: 'GY-1', title: 'Fast gates', documentation: { id: 'DOCS', paths: ['docs/'], text: 'Documentation reflects this change', changelog: null } },
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

test('unit:worker-prompt-names-review-self — every worker request names review self with the item key and the configured CLI, before the autonomous-session line (GY-1987)', () => {
  // The instruction is unconditional: any item's request carries it, with the configured CLI path
  // and the item's key, so the worker judges its own diff by the reviewer's standard before it
  // submits, and the sentence sits directly before the autonomous-session line that ends the
  // request, so reading order runs: do the work, self-review it, then decide and act on your own.
  const sentence = (cli: string, key: string) => `Before complete, run node ${cli} review self ${key}, judge your diff by what it prints and fix each BLOCKING finding first. `;
  for (const fastGates of [true, false]) {
    const request = render(fastGates);
    assert.ok(request.includes(sentence(cli, 'GY-1')), 'the request names review self with the configured CLI and the item key');
    const at = request.indexOf(sentence(cli, 'GY-1')), autonomous = request.indexOf('Decide and act on your own: implement the item');
    assert.ok(at >= 0 && at < autonomous, 'the self-review instruction sits before the autonomous-session line');
    assert.equal(request.split(sentence(cli, 'GY-1')).length, 2, 'the instruction appears exactly once');
    assert.ok(request.indexOf('review self') === at + `Before complete, run node ${cli} `.length, 'the self-review instruction is the first mention of review self');
  }
  // An item with everything attached — criteria, documentation obligation, planned files — carries
  // the same instruction, naming its own key.
  const full = workerPrompt(
    { cliPath: cli, repository: 'owner/graphyard', fastGates: true },
    { key: 'GY-2', title: 'Anything', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], documentation: { id: 'DOCS', text: 'Documentation reflects this change', paths: ['docs/'], changelog: null } },
    { principal: 'graphyard-test-1' }, 3,
  );
  assert.ok(full.includes(sentence(cli, 'GY-2')), 'any item\'s request names review self with its own key');
  // The sentence is a pure function of its inputs: the same item renders byte-identical requests.
  assert.equal(workerPrompt({ cliPath: cli }, { key: 'GY-2', title: 'Anything' }, { principal: 'graphyard-test-1' }, 3), workerPrompt({ cliPath: cli }, { key: 'GY-2', title: 'Anything' }, { principal: 'graphyard-test-1' }, 3), 'the same inputs render byte-identical');
});
