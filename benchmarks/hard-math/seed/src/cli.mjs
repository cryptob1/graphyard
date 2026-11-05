import {createInterface} from 'node:readline';
import {solve} from './solver.mjs';
import {failure} from './contract.mjs';
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  try {
    let value;
    try { value = JSON.parse(line); } catch { throw {code:'INVALID_JSON'}; }
    console.log(JSON.stringify(solve(value)));
  } catch(error) { console.log(JSON.stringify(failure(error))); process.exitCode = 1; }
}
