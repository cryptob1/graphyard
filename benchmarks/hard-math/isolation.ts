import { masterRunSchema } from '../../src/master/profiles.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../../src/cli/test-isolation.js';
import { trialEnvironment } from '../../src/merge-writer/trial.js';
import { mergeWriterReads } from '../../src/daemon/cycle-merge-writer.js';
import { defaultChildRun } from '../../src/child-runner.js';
import { operatorCapabilities } from '../../src/model.js';
import { shellQuote } from '../../src/install/transport.js';
import { git, command } from './process.js';
export const benchmarkRoot=fileURLToPath(new URL('.',import.meta.url));
export const codeRoot=resolve(benchmarkRoot,'../..');
export interface Credential {id:string;role:'admin'|'coordinator'|'worker'|'producer';token:string;proofs?:string[];sessionKind?:'ai'}
export const credential=(id:string,role:Credential['role'],proofs?:string[]):Credential=>({id,role,token:randomBytes(32).toString('hex'),...(proofs?{proofs}:{}),...(role==='admin'?{sessionKind:'ai' as const}:{})});
export async function isolatedRepository(directory:string,signal?:AbortSignal) {
  const root=join(directory,'repository'),origin=join(directory,'origin.git');
  const run=async(program:string,args:string[],options:any={})=>(await command(program,args,{...options,signal})).stdout;
  const git=async(root:string,...args:string[])=>(await run('git',['-C',root,...args])).trim();
  await cp(join(benchmarkRoot,'seed'),root,{recursive:true});
  await git(root,'init','-q','-b','main');await git(root,'config','user.name','Hard math benchmark');await git(root,'config','user.email','hard-math@example.invalid');
  // Identical initial tree/commit in both comparison conditions.
  await git(root,'add','.');
  await command('git',['-C',root,'commit','-q','-m','Frozen exact roots workbench v1 seed'],{env:{...process.env,GIT_AUTHOR_DATE:'2000-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2000-01-01T00:00:00Z'},signal});
  await mkdir(origin);await git(origin,'init','--bare','-q','-b','main');
  // Native preparation and the worker CLI both check the repository identity.
  // Keep that identity while serving fetches and pushes from this run's bare Git.
  const transport=join(directory,'local-git-fetch.sh');
  await writeFile(transport,`#!/bin/sh\nexec git-upload-pack ${shellQuote(origin)}\n`,{mode:0o700});
  await git(root,'remote','add','origin','git@github.com:scratch/hard-math.git');
  await git(root,'config','core.sshCommand',shellQuote(transport));
  await git(root,'config','ssh.variant','simple');
  await git(root,'config','remote.origin.pushurl',origin);
  const writer=mergeWriterReads({baseBranch:'main',repository:'scratch/hard-math',run:masterRunSchema.parse({mergeWriter:{deployKeyFile:join(directory,'unused')}})},root,run,{base:directory,record:async()=>{}});
  const startingCommit=await git(root,'rev-parse','HEAD');await writer.push(startingCommit,'0'.repeat(40));await writer.fetch();
  return {root,origin,startingCommit};
}
export async function startPlane(directory:string,root:string,credentials:Credential[],graphyardCommit:string,signal?:AbortSignal) {
  await mkdir(join(directory,'postgres'),{recursive:true,mode:0o700});
  await writeFile(join(directory,'postgres/password'),randomBytes(32).toString('hex'),{mode:0o600});
  await writeFile(join(directory,'postgres/port'),String(await freePort()));
  const port=await freePort(),url=`http://127.0.0.1:${port}`;
  await writeFile(join(directory,'local-server.json'),JSON.stringify({PORT:String(port),HOST:'127.0.0.1',GITHUB_REPOSITORY:'scratch/hard-math',GITHUB_BASE_BRANCH:'main',GRAPHYARD_REPOSITORY_ROOT:root,GRAPHYARD_BUILD_SHA:graphyardCommit,GRAPHYARD_PRINCIPALS:JSON.stringify(credentials)}),{mode:0o600});
  const env=trialEnvironment(process.env);
  const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),join(codeRoot,'src/install/local-runtime.ts'),directory],{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe'],signal});
  let log='';child.stdout.on('data',part=>{log+=part;});child.stderr.on('data',part=>{log+=part;});
  let failure:Error|null=null;child.on('error',error=>{failure=error;});
  const exited=new Promise<void>(accept=>child.once('close',()=>accept()));
  async function stop() {
    try{process.kill(-child.pid!,'SIGTERM');}catch{/* already closed */}
    const timer=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},15_000);
    try{await exited;}finally{clearTimeout(timer);await writeFile(join(directory,'runtime.log'),log,{mode:0o600});}
  }
  try {
    const end=Date.now()+90_000;
    while(!await fetch(`${url}/healthz?ready`,{signal:AbortSignal.timeout(1000)}).then(r=>r.ok,()=>false)) {
      if(failure || child.exitCode!==null || Date.now()>end) throw new Error(`Isolated control plane did not start: ${failure??log}`);
      await new Promise(accept=>setTimeout(accept,100));
    }
  } catch(error) {await stop();throw error;}
  const call=async(path:string,token:string,body?:unknown):Promise<any>=>{
    const response=await fetch(`${url}/api/${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});
    const result=await response.json() as any;
    if(!response.ok) throw new Error(`${path} HTTP${response.status}: ${JSON.stringify(result)}`);
    return result;
  };
  return {url,call,stop};
}
export async function operator(plane:Awaited<ReturnType<typeof startPlane>>,admin:string) {
  const token=randomBytes(32).toString('hex');
  await plane.call('operator-agents',admin,{id:'benchmark-master',displayName:'Hard math supervising master',capabilities:operatorCapabilities,scope:{repositories:['scratch/hard-math'],workItems:['*']},token,reason:'Isolated benchmark coordination, no implementation or proof authority'});
  return token;
}
