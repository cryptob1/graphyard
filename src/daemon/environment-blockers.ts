// GY-3553: blockers caused by the host, not the change, are the loop's to clear once the cause is gone.
import type { Work } from '../model.js';

/** What the loop reads of the host each cycle to judge an environment blocker. */
export interface EnvironmentReadings {
  /** A host heavy-job slot is free and heavy work is not drained. */
  slotsFree: boolean;
  /** The CPU is neither saturated nor too hot for a launch. */
  heatClear: boolean;
  /** The commit the served CLI release holds, and the commit the server runs. */
  cliCommit: string | null;
  serverCommit: string | null;
  /** Whether a worktree path, or the nearest directory above it that exists, can be written. */
  writable: (path: string) => boolean | Promise<boolean>;
}

type Cause = 'heavy-job slot wait' | 'heat wait' | 'host verification timeout' | 'CLI/server commit mismatch' | 'unwritable worktree';

/** A blocker that names a person's decision or a fault of the change is never the loop's. */
const notEnvironment = /\b(human|person|owner|operator|approv|credential|login|token|password|assert|AssertionError|TS\d{4}|type ?error|syntax ?error|test(s)? failed|failing test|build (error|failed)|criteri)/i;
const causes: [Cause, RegExp][] = [
  ['CLI/server commit mismatch', /CLI (commit )?\S+ and server (commit )?\S+ differ/i],
  ['unwritable worktree', /\b(EACCES|EROFS|EPERM|read-only file system|not writable|unwritable)\b/i],
  ['heavy-job slot wait', /heavy-job slot|verification slot|\bslot (wait|timeout|timed out)|waiting for a (trial |worker )?slot/i],
  ['heat wait', /too hot|\bheat\b|CPU pressure|°C|celsius/i],
  ['host verification timeout', /(host|verification|verify)\b.{0,60}\btim(ed|e)[ -]?out|\btim(ed|e)[ -]?out\b.{0,60}\b(host|verification|verify)/i],
];

/** The environment cause a blocker names, or null when it is not one the loop can test. */
export function environmentCause(blocker: string): Cause | null {
  if (notEnvironment.test(blocker)) return null;
  return causes.find(([, pattern]) => pattern.test(blocker))?.[0] ?? null;
}

/** The worktree a blocker's unwritable path names: the absolute path in it, else the item's newest workspace. */
const blockedPath = (item: Work) => /(\/[^\s'"`:,;)]+)/.exec(item.blocker ?? '')?.[1] ?? item.workspaces?.at(-1)?.path ?? null;

/** Whether the cause an item's blocker names has cleared on this host's readings. */
export async function causeCleared(cause: Cause, item: Work, readings: EnvironmentReadings): Promise<boolean> {
  switch (cause) {
    case 'heavy-job slot wait': return readings.slotsFree;
    case 'heat wait': return readings.heatClear;
    case 'host verification timeout': return readings.slotsFree && readings.heatClear;
    case 'CLI/server commit mismatch': return !!readings.cliCommit && readings.cliCommit === readings.serverCommit;
    case 'unwritable worktree': { const path = blockedPath(item); return !!path && await readings.writable(path); }
  }
}
