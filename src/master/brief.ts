// Concern: the install's product brief (GY-3274) — `master brief set FILE REASON` and
// `master brief show`, kept in project memory and mirrored to the control plane for its Product page.
import { readFile } from 'node:fs/promises';
import { readProjectMemory, writeProjectMemory, type ProductBrief } from '../project-memory.js';
import { setProductBrief } from '../model/project-memory.js';

export const briefUsage = 'Use master brief set FILE REASON | master brief show';

/** What `master brief` needs beyond the checkout: the control plane's word on a credential, and the mirror it serves the Product page from. */
export interface BriefDependencies {
  /** The control plane's status for one credential, naming the actor it belongs to. */
  status: (credential: string) => Promise<{ actor?: { id?: string; role?: string } }>;
  /** The credential the invoking environment carries, when any: the master's own session runs with none. */
  callerCredential?: () => Promise<string | undefined>;
  /** Publishes the stored brief to the control plane, whose dashboard shows it read-only. */
  publish?: (brief: ProductBrief) => Promise<unknown>;
  now?: () => number;
}

/**
 * Sets and shows the install's one product brief. The brief lives in project memory; setting it also
 * publishes it to the control plane so the Product page shows the same text. An environment carrying
 * a worker's credential is refused, exactly as for lessons.
 */
export async function runBriefCommand(root: string, by: string, args: string[], deps: BriefDependencies) {
  const caller = await deps.callerCredential?.().catch(() => undefined);
  if (caller) {
    const actor = (await deps.status(caller)).actor;
    if (actor?.role === 'worker') throw new Error(`A worker identity (${actor.id ?? 'unknown'}) cannot write the product brief; it is the master's own`);
  }
  if (args[0] === 'set') {
    const file = args[1], why = args.slice(2).join(' ').trim();
    if (!file || !why) throw new Error(briefUsage);
    const memory = await readProjectMemory(root);
    const brief = setProductBrief(memory, { markdown: await readFile(file, 'utf8'), by, why, at: new Date(typeof deps.now === 'function' ? deps.now() : Date.now()).toISOString() });
    await writeProjectMemory(root, memory);
    if (deps.publish) await deps.publish(brief);
    return { set: { updatedAt: brief.updatedAt, by: brief.by, why: brief.why, words: brief.history[0].words }, history: brief.history.length };
  }
  if (args[0] === 'show') {
    const brief = (await readProjectMemory(root)).brief;
    return brief ? { markdown: brief.markdown, updatedAt: brief.updatedAt, by: brief.by, why: brief.why, history: brief.history } : { markdown: null, detail: 'No product brief set yet; master brief set FILE REASON records one' };
  }
  throw new Error(briefUsage);
}
