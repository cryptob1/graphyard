import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { command } from './process.js';
import type { Request } from './generator.js';
export const oracleSource=fileURLToPath(new URL('./oracle/verify.py',import.meta.url));
export const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export async function oracle(python:string, values:{request:Request;output?:unknown;reference?:boolean}[], source=oracleSource,signal?:AbortSignal) {
  const result=await command(python,[source],{input:values.map(v=>JSON.stringify(v)).join('\n')+'\n',timeoutMs:120_000,signal});
  const lines=result.stdout.trim().split('\n').map(line=>JSON.parse(line));
  if(lines.length!==values.length) throw new Error('Oracle did not answer every input');
  return lines as any[];
}
export async function oracleDigest(source=oracleSource,signal?:AbortSignal) {
  return digest(Buffer.concat([await readFile(source),await readFile(new URL('./oracle/requirements.txt',import.meta.url))]));
}
