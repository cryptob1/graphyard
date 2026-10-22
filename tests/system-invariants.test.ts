import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repeatingPaths, repetitionReviewSection, reviewPrompt } from '../src/reviewer.js';

// GY-404: every fault found on 2026-09-25 passed its own item's gates; they appeared only from
// interaction over time. The review of a change to code that runs on every loop cycle asks what repetition does.

const sha = (seed: string) => seed.repeat(40).slice(0, 40);

test('unit:reviewer-repeat-question — the review of a change to the loop, master or merge writer asks what repetition does and never requires soak coverage', () => {
  const binding = { key: 'GY-404', pr: 7, sha: sha('a'), baseSha: sha('b'), policyRevision: 1 };
  const prompt = (files: string[] | null) => reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, [{ id: 'AC-1', text: 'Behaves' }], undefined, files);
  for (const file of ['src/daemon/cycle.ts', 'src/master/status.ts', 'src/merge-writer/trial.ts']) {
    const text = prompt(['docs/master-agent.md', file]);
    assert.ok(text.includes(`This change touches ${file}`), `${file} is named: ${text}`);
    assert.match(text, /what it does when repeated across many cycles, heads and items/);
    assert.match(text, /never require new soak-suite coverage/);
    assert.doesNotMatch(text, /must be covered by the soak suites|is a BLOCKING finding/, 'the review asks about repetition but never demands soak coverage');
  }
  for (const files of [['src/model/work.ts', 'docs/coordination.md'], ['src/github-cache.ts', 'src/masterful.ts', 'src/daemonic/x.ts']]) assert.doesNotMatch(prompt(files), /repeated across many cycles/, `${files.join(', ')} runs on no loop cycle`);
  // A head nobody has observed yet: the question is asked, conditioned on the paths it names.
  assert.match(prompt(null), /If this change touches src\/daemon\/, src\/master\/, src\/merge-writer\/, which run on every loop cycle, ask what it does when repeated/);
  assert.deepEqual([...repeatingPaths], ['src/daemon/', 'src/master/', 'src/merge-writer/']);
  assert.equal(repetitionReviewSection(['README.md']), '');
});
