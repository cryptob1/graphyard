// Concern: `graphyard master brief` — the install's product brief (GY-3274), kept in project memory
// and mirrored to the control plane, whose dashboard shows it on its Product page.
import { runBriefCommand } from '../../master/brief.js';
import { unhandled, type MasterSession } from './session.js';

export async function briefCommand(session: MasterSession): Promise<unknown> {
  const { id, args, print, root, masterApi, masterMutation, coordinator, context } = session;
  if (id !== 'brief') return unhandled;
  return print(await runBriefCommand(root, coordinator?.actor?.id ?? 'master', args, {
    status: credential => masterApi('status', credential),
    callerCredential: () => context.individualToken(),
    publish: brief => masterMutation('product-brief', brief),
  }));
}
