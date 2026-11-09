import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execute } from '../../benchmarks/hard-math/runner.js';
import { controlledWallClockSeconds, fixtureExecutor } from '../../benchmarks/hard-math/fixture.js';
import { temporaryDirectory } from './temp-dirs.js';

/** One controlled-executor run on its own scratch control plane, for the hard-math test files. */
export async function runFixture(python:string,label:string,options:Parameters<typeof fixtureExecutor>[1]={},maxAgentSeconds=1000,mode:'team'|'single'='team',executor:Parameters<typeof execute>[1]=c=>fixtureExecutor(c,options)) {
  const testRoot=join(process.cwd(),'.graphyard','hard-math-fixtures');
  await mkdir(testRoot,{recursive:true});
  const parent=await temporaryDirectory(`hard-math-${label}`,testRoot);
  // Only controlled scheduling changes; frozen math and actual-agent limits are unchanged.
  const wallClockSeconds=options.injectRepair?controlledWallClockSeconds.repair:controlledWallClockSeconds.standard;
  return execute({id:`fixture-${label}`,mode,profileVersion:'v1',seed:1,wallClockSeconds,budget:{authorization:'Controlled fixtures, no model calls or spending',maxAgentSeconds,maxTokens:null,maxCost:null,currency:'USD',priceSource:{url:null,date:null,reason:'No real model usage in controlled executor fixtures'}},eligibleModels:['fixture-cheap','fixture-expensive'],sourceRoot:process.cwd(),oraclePython:python,oracleDirectory:join(parent,'oracle'),runDirectory:join(parent,'run'),credentialDirectory:join(parent,'install')},executor);
}
