import { spawn } from 'node:child_process';
export async function command(program: string, args: string[], options: {cwd?:string;input?:string;timeoutMs?:number;env?:NodeJS.ProcessEnv;signal?:AbortSignal;allowFailure?:boolean}={}) {
  const child=spawn(program,args,{cwd:options.cwd,env:options.env,stdio:['pipe','pipe','pipe'],signal:options.signal});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;}); child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdin.on('error',()=>{}); child.stdin.end(options.input??'');
  const timer=setTimeout(()=>child.kill('SIGKILL'),options.timeoutMs??120_000);
  try {
    const code=await new Promise<number|null>((accept,reject)=>{child.once('error',reject);child.once('close',accept);});
    if(code!==0 && !options.allowFailure) throw new Error(`${program} ${args.join(' ')} exited ${code}: ${stderr.slice(-3000)}`);
    return {stdout,stderr,code};
  } finally {clearTimeout(timer);}
}
export const git=async(root:string,...args:string[])=>(await command('git',['-C',root,...args])).stdout.trim();
