// The worker's supported sync, as an integration test runs it inside the worker confinement
// (tests/worker-cherry-pick-cleanup.test.ts): `syncWork` against the worktree named in
// WORKER_TREE, with the control-plane reads stubbed, so the test exercises the real git flow the
// `graphyard sync` command runs — including the merge it is refused and the recovery it performs.
import { syncWork } from '../../src/cli/workspace.js';

const tree = process.env.WORKER_TREE, key = process.env.WORKER_KEY;
if (!tree || !key) throw new Error('Set WORKER_TREE and WORKER_KEY');
process.chdir(tree);
const status = { baseBranch: 'main', mergeWriter: { merger: 'control-plane', line: 'The control plane is the merge writer' } };
const work = { id: 'integration-worker-cherry-pick-cleanup', key, workspaces: [{ epoch: 1, branch: 'graphyard/gy-2950-1', host: 'test-host', path: tree }], lease: { epoch: 1 } };
const printed = [];
await syncWork({ api: async () => status, print: value => printed.push(value) }, work);
console.log(`WORKER-SYNC ${JSON.stringify(printed.at(-1))}`);
