// GY-3152: a loop process over a pipeline world (tests/helpers/pipeline-world.ts), for the scenario
// that replaces the loop mid-gate: it runs the real cycle every 300 ms until it is killed.
import { pipelineLoop, storeSnapshot } from './pipeline-world.js';

const where = JSON.parse(process.argv[2]!);
const { snapshot } = storeSnapshot(where.database);
const loop = pipelineLoop({ ...where, snapshot }, { gate: true });
for (;;) {
  await loop.cycle();
  for (const line of loop.lines.splice(0)) console.error(line);
  await new Promise(resolve => setTimeout(resolve, 300));
}
