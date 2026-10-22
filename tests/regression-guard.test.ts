import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shippedBy } from '../src/regression-guard.js';
import { parseLocalScopeDiff } from '../src/sync.js';
import type { ScopeFile, Work } from '../src/model.js';

const blob = (label: string) => label.repeat(40).slice(0, 40);

test('shippedBy names the delivered work whose observed files carry a path', () => {
  const done = (key: string, files: string[] = []) => ({ key, id: key, stage: 'done', observation: { files } } as unknown as Work);
  const all = [done('GY-33', ['src/quarantine.ts', 'tests/quarantine.test.ts']), done('GY-1', ['src/reviewer.ts']), { key: 'GY-55', id: 'GY-55', stage: 'build' } as unknown as Work];
  assert.deepEqual(shippedBy('src/quarantine.ts', all), ['GY-33']); assert.deepEqual(shippedBy('src/reviewer.ts', all), ['GY-1']); assert.deepEqual(shippedBy('src/nobody.ts', all), []);
});

test('the local diff parser turns git raw and numstat output into the same file records the provider observation carries', () => {
  const raw = `:100644 100644 ${blob('1')} ${blob('2')} M\0src/engine.ts\0:100644 000000 ${blob('3')} ${'0'.repeat(40)} D\0src/reviewer.ts\0:100644 100644 ${blob('4')} ${blob('4')} R100\0web/logo.png\0web/moved.png\0:000000 100644 ${'0'.repeat(40)} ${blob('5')} A\0src/new.ts\0`;
  const numstat = `3\t1\tsrc/engine.ts\0` + `0\t12\tsrc/reviewer.ts\0` + `-\t-\t\0web/logo.png\0web/moved.png\0` + `4\t0\tsrc/new.ts\0`;
  const files = parseLocalScopeDiff(raw, numstat);
  assert.deepEqual(files, [
    { path: 'src/engine.ts', status: 'modified', sha: blob('2'), additions: 3, deletions: 1, binary: false, baseSha: blob('1') },
    { path: 'src/reviewer.ts', status: 'removed', sha: null, additions: 0, deletions: 12, binary: false, baseSha: blob('3') },
    { path: 'web/moved.png', status: 'renamed', sha: blob('4'), additions: 0, deletions: 0, binary: true, baseSha: null, previousPath: 'web/logo.png', previousBaseSha: blob('4') },
    { path: 'src/new.ts', status: 'added', sha: blob('5'), additions: 4, deletions: 0, binary: false, baseSha: null },
  ]);
  assert.deepEqual(parseLocalScopeDiff('', ''), []);
});
