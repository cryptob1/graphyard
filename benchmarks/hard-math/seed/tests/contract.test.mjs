import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseRequest} from '../src/contract.mjs';
test('unit:workbench-contract',()=>{
 assert.deepEqual(parseRequest({coefficients:['0','1','-2'],precisionBits:64}),{coefficients:[1n,-2n],precisionBits:64});
 assert.throws(()=>parseRequest({coefficients:['0'],precisionBits:64}),{code:'ZERO_POLYNOMIAL'});
});
