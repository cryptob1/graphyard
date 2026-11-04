import { spawn } from 'node:child_process';
import { ChildProcessError, type ChildRun } from '../../src/child-runner.js';
export async function command(program: string, args: string[], options: {cwd?:string;input?:string;timeoutMs?:number;env?:NodeJS.ProcessEnv;signal?:AbortSignal;allowFailure?:boolean;includeStdout?:boolean}={}) {
  const child=spawn(program,args,{cwd:options.cwd,env:options.env,stdio:['pipe','pipe','pipe'],detached:true});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;}); child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdin.on('error',()=>{}); child.stdin.end(options.input??'');
  const kill=()=>{try {process.kill(-child.pid!,'SIGKILL');}catch {/* exited */}};
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;kill();},options.timeoutMs??120_000);
  options.signal?.addEventListener('abort',kill,{once:true});
  if(options.signal?.aborted) kill();
  try {
    const {code,signal,cause}=await new Promise<{code:number|null;signal:NodeJS.Signals|null;cause?:unknown}>(accept=>{
      child.once('error',cause=>accept({code:null,signal:null,cause}));
      child.once('close',(code,signal)=>accept({code,signal}));
    });
    if(cause || timedOut || options.signal?.aborted || signal || code!==0 && !options.allowFailure) {
      const error=new ChildProcessError(program,args,{stdout,stderr,status:code,signal,timedOut,timeoutMs:options.timeoutMs??120_000,cause});
      // Keep diagnostics bounded; callers still receive the complete captured streams.
      error.message=`${program} ${args.join(' ')} ${options.signal?.aborted?String(options.signal.reason):timedOut?'timed out':cause?`could not be started: ${cause instanceof Error?cause.message:String(cause)}`:`exited ${code}${signal?` (${signal})`:''}`}: ${stderr.slice(-3000)}${options.includeStdout && stdout?'\nstdout:\n'+stdout.slice(-3000):''}`;
      throw error;
    }
    return {stdout,stderr,code};
  } finally {clearTimeout(timer);options.signal?.removeEventListener('abort',kill);}
}
export const git=async(root:string,...args:string[])=>(await command('git',['-C',root,...args])).stdout.trim();

/** The real daemon's adapter, bounded by the run deadline and cancellation signal. */
export function boundedChildRun(input:{deadline:number;signal:AbortSignal;enforce():void;capture(program:string,args:string[],stdout:string):void}):ChildRun {
  return async(program,args,options={})=>{
    input.enforce();
    const words=[...(options.wrapper??[]),program,...args];
    try {
      const result=await command(words[0],words.slice(1),{cwd:options.cwd,env:options.env,timeoutMs:Math.min(options.timeoutMs??90_000,Math.max(1,input.deadline-Date.now())),signal:input.signal});
      input.capture(program,args,result.stdout);return result.stdout;
    } catch(error) {
      if(error instanceof ChildProcessError) input.capture(program,args,error.stdout);
      throw error;
    }
  };
}
