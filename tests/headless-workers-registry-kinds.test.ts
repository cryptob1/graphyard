import { after, before } from 'node:test';
import { headlessWorkerKindTest, headlessWorkers, registryKinds, type HeadlessWorkers } from './helpers/headless-workers.js';

// GY-3259: the other half of the headless worker kind matrix — the kinds launched only through an
// agent-registry contract — split from tests/headless-workers.test.ts because one file cannot host
// the whole matrix inside the merge trial's five-minute per-file bound (tests/helpers/bounded-tests.mjs).
let workers: HeadlessWorkers;
before(async () => { workers = await headlessWorkers('headless-workers-registry'); });
after(async () => { await workers.stop(); });
for (const kind of registryKinds) headlessWorkerKindTest(() => workers, kind);
