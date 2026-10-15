import { loadMasterConfig } from '/home/vish/code/graphyard-pilot-coordinator/src/master.js';
async function test() {
  const config = await loadMasterConfig('/home/vish/code/graphyard-snake-v2');
  console.log('operatorAgent:', !!config.operatorAgent, 'approver:', !!config.approver);
}
test();
