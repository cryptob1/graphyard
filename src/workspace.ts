import { posix } from 'node:path';

export function workspacePath(path: string) {
  return posix.normalize(path).replace(/\/$/, '') || '/';
}
export function pathsOverlap(a: string, b: string) {
  a = workspacePath(a); b = workspacePath(b);
  return a === b || a === '/' || b === '/' || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
export function validBranch(branch: string) {
  return /^graphyard\/[a-zA-Z0-9/_-]+$/.test(branch) && !branch.endsWith('/') && !branch.includes('//');
}
