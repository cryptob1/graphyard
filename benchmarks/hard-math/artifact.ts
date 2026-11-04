import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { trialConfinement, trialEnvironment } from '../../src/merge-writer/trial.js';
import { freePort } from '../../src/cli/test-isolation.js';
import { command } from './process.js';
import { generate } from './generator.js';
import { oracle } from './oracle.js';
import type { Receipt } from './receipt-schema.js';

/** All artifact code executes behind the ordinary credential-free trial boundary. */
export async function verifyArtifact(input:{root:string;sha:string;seed:number;python:string;oracleSource:string;oracleDigest:string;scratch:string;hidden:string[];signal?:AbortSignal}):Promise<NonNullable<Receipt['artifact']>> {
  input.signal?.throwIfAborted();
  const signal=(ms:number)=>AbortSignal.any([AbortSignal.timeout(ms),...(input.signal?[input.signal]:[])]);
  await mkdir(input.scratch,{recursive:true});
  const wrapper=trialConfinement(input.hidden,[input.root,input.scratch]);
  const env={...trialEnvironment(process.env),HOME:input.scratch,TMPDIR:input.scratch};
  const run=(args:string[],stdin='')=>command(wrapper[0],[...wrapper.slice(1),process.execPath,...args],{cwd:input.root,input:stdin,env,signal:input.signal});
  await command(wrapper[0],[...wrapper.slice(1),'npm','run','build'],{cwd:input.root,env,signal:input.signal});
  const samples=generate(input.seed), requests=samples.map(({coefficients,precisionBits})=>({coefficients,precisionBits}));
  const cli=await run(['src/cli.mjs'],requests.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const answers=cli.stdout.trim().split('\n').map(line=>JSON.parse(line));
  if(answers.length!==requests.length) throw new Error('CLI omitted results');
  const checks=await oracle(input.python,requests.map((request,i)=>({request,output:answers[i]})),input.oracleSource,input.signal);
  if(checks.some(check=>!check.pass)) throw new Error(`CLI exact oracle rejected: ${JSON.stringify(checks)}`);
  // Both stable errors and continuation are part of the CLI contract.
  const invalid=await command(wrapper[0],[...wrapper.slice(1),process.execPath,'src/cli.mjs'],{cwd:input.root,env,signal:input.signal,input:'{\n'+JSON.stringify({coefficients:['0'],precisionBits:64})+'\n'+JSON.stringify({coefficients:['1'],precisionBits:64})+'\n',allowFailure:true});
  const errors=invalid.stdout.trim().split('\n').map(line=>JSON.parse(line));
  if(invalid.code===0 || errors[0]?.error?.code!=='INVALID_JSON' || errors[1]?.error?.code!=='ZERO_POLYNOMIAL' || errors[2]?.roots?.length!==0) throw new Error('CLI error/continuation contract failed');
  const port=await freePort(),url=`http://127.0.0.1:${port}`;
  const server=spawn(wrapper[0],[...wrapper.slice(1),process.execPath,'src/server.mjs'],{cwd:input.root,env:{...env,PORT:String(port),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe'],detached:true});
  let log='';server.stdout.on('data',v=>{log+=v;});server.stderr.on('data',v=>{log+=v;});
  let spawnError:Error|null=null;server.on('error',e=>{spawnError=e;});
  const closed=new Promise<void>(accept=>server.once('close',()=>accept()));
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  const cancel=()=>{void browser?.close();try {process.kill(-server.pid!,'SIGKILL');} catch {}};
  input.signal?.addEventListener('abort',cancel,{once:true});
  try {
    input.signal?.throwIfAborted();
    const deadline=Date.now()+10_000;
    while(true) {
      input.signal?.throwIfAborted();
      if(await fetch(url,{signal:signal(500)}).then(r=>r.ok,()=>false)) break;
      if(spawnError || server.exitCode!==null || Date.now()>deadline) throw new Error(`Artifact server did not start: ${spawnError??log}`);
      await new Promise(accept=>setTimeout(accept,100));
    }
    const response=await fetch(`${url}/roots`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobs:requests}),signal:signal(120_000)});
    const result=await response.json() as any;
    if(!response.ok || JSON.stringify(result.results)!==JSON.stringify(answers)) throw new Error('API/CLI disagree');
    for(const body of ['{', '{}', '{"jobs":false}']) {
      const response=await fetch(`${url}/roots`,{method:'POST',body,signal:signal(10_000)});
      if(response.status!==400) throw new Error('API accepted malformed envelope');
    }
    const mixed=await fetch(`${url}/roots`,{method:'POST',body:JSON.stringify({jobs:[requests[0],{coefficients:['0'],precisionBits:64},requests.at(-1)]}),signal:signal(120_000)}).then(r=>r.json()) as any;
    if(JSON.stringify(mixed.results?.[0])!==JSON.stringify(answers[0]) || mixed.results?.[1]?.error?.code!=='ZERO_POLYNOMIAL' || JSON.stringify(mixed.results?.[2])!==JSON.stringify(answers.at(-1))) throw new Error('API lost ordered per-job errors');
    browser=await chromium.launch({headless:true,timeout:10_000});
    input.signal?.throwIfAborted();
    const page=await browser.newPage();
    page.setDefaultTimeout(10_000);
    // Real DOM interactions against the delivered server, checked against oracle-certified CLI.
    for(const index of [2,3,5]) {
      await page.goto(url);
      await page.locator('#coefficients').fill(requests[index].coefficients.join(' '));
      await page.locator('#precisionBits').fill('64');
      const response=page.waitForResponse(r=>r.url()===`${url}/roots`&&r.request().method()==='POST');
      await page.locator('#solve').click();await response;
      for(const root of answers[index].roots) {
        await page.locator('#results').filter({hasText:`${root.lo.n}/${root.lo.d}`}).waitFor();
        const text=await page.locator('#results').innerText();
        if(!text.includes(`${root.hi.n}/${root.hi.d}`) || !text.includes(String(root.multiplicity))) throw new Error('UI omitted interval or multiplicity');
      }
    }
    await page.locator('#coefficients').fill('0');await page.locator('#solve').click();
    await page.locator('#error').filter({hasText:'ZERO_POLYNOMIAL'}).waitFor();
    return {sha:input.sha,cli:true,api:true,ui:true,cases:requests.length,oracleDigest:input.oracleDigest};
  } finally {input.signal?.removeEventListener('abort',cancel);cancel();await browser?.close();await closed;}
}
