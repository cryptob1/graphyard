// Shared case ledger for every trusted contract. Each contract binds it to its own fixed
// `requiredCases`, so the ledger can never name a case the contract does not register.
//
// Records each case as it runs so an interrupted exercise still reports which cases
// completed, which one failed, and which never executed. A started case counts as
// failing until it finishes, so a throw anywhere keeps the failure attributed.
export function createInventory(requiredCases) {
  const cases = requiredCases.map(id => ({ id, result: 'skipped' }));
  const find = id => { const entry = cases.find(c => c.id === id); if (!entry) throw new Error(`Unknown acceptance case ${id}`); return entry; };
  let running = null;
  return {
    get cases() { return cases.map(entry => ({ ...entry })); },
    get executed() { return cases.filter(entry => entry.result !== 'skipped').length; },
    get skipped() { return cases.filter(entry => entry.result === 'skipped').length; },
    get complete() { return running === null && cases.every(entry => entry.result === 'pass'); },
    begin(id) {
      if (running !== null) throw new Error(`Acceptance case ${running} did not finish`);
      if (find(id).result !== 'skipped') throw new Error(`Acceptance case ${id} ran twice`);
      find(id).result = 'fail'; running = id;
    },
    pass(id) { if (running !== id) throw new Error(`Acceptance case ${id} was not started`); find(id).result = 'pass'; running = null; },
  };
}
