import { demand } from '../../model.js';
import type { Ctx } from './types.js';

export function screen(c: Ctx) {
  demand(c.actor.role === 'admin' || c.actor.role === 'operator-agent' || (c.actor.role === 'reader' && c.actor.team === 'maintainer'), 'Only operators, maintainers and the master may change priority', 403);
  c.data = { ...c.data, oldPriority: c.work.priority, newPriority: c.data.priority,
    reason: c.data.source === 'dashboard' ? `Priority changed from P${c.work.priority} to P${c.data.priority} from the dashboard` : c.data.reason };
}

export function run({ work, data }: Ctx) {
  work.priority = data.priority;
}
