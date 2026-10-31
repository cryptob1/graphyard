import { readFile } from 'node:fs/promises';
import type { MasterConfig } from '../master.js';
import { removeReviewerProfile, saveReviewerProfile } from '../reviewer.js';

/** The reviewer launch profiles. */
export async function reviewerCommand(root: string, _master: MasterConfig, args: string[], print: (value: unknown) => void) {
  if (args[0] === 'add' && args[1]) return print(await saveReviewerProfile(root, JSON.parse(await readFile(args[1], 'utf8'))));
  if (args[0] === 'remove' && args[1]) return print(await removeReviewerProfile(root, args[1]));
  throw new Error('Use master reviewer add FILE or master reviewer remove NAME');
}
