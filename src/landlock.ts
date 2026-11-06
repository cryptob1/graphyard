// GY-3169: socket confinement (src/master/socket-confinement.ts) refuses every session and trial
// below Landlock ABI 9, so up's preflight and doctor read the ABI first, the same way it does.
import { execFileSync } from 'node:child_process';

export const landlockAbiRequired = 9;

/** The host's Landlock ABI: landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION). Throws when it cannot be read. */
export function readLandlockAbi(): number {
  const read = 'import ctypes, os\nlibc = ctypes.CDLL(None, use_errno=True)\nabi = libc.syscall(444, 0, 0, 1)\nprint(abi if abi >= 0 else "error " + os.strerror(ctypes.get_errno()))';
  const out = execFileSync('python3', ['-I', '-c', read], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!/^\d+$/.test(out)) throw new Error(out.replace(/^error /, 'landlock_create_ruleset failed: '));
  return Number(out);
}

/** Why this host cannot run Graphyard sessions, naming the ABI found and the kernel needed; null when it can. */
export function landlockRefusal(read: () => number = readLandlockAbi): string | null {
  let abi: number;
  try { abi = read(); } catch (error: any) { return `could not read the Landlock ABI (${String(error.message ?? error).split('\n')[0]}); Graphyard needs Linux Landlock ABI ${landlockAbiRequired} or newer (Linux 7.0 or later) to confine sessions`; }
  return abi >= landlockAbiRequired ? null : `this kernel offers Landlock ABI ${abi}; Graphyard needs Linux Landlock ABI ${landlockAbiRequired} or newer (Linux 7.0 or later) to confine sessions, so nothing would launch`;
}
