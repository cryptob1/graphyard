// Concern: `graphyard master usage [--days N]` (GY-3289) — the tokens the project's agents spent and what they cost.
import { parseArgs } from 'node:util';
import { costReport, type CostSummary } from '../../model/token-costs.js';
import { unhandled, type MasterSession } from './session.js';

export async function usageCommand(session: MasterSession): Promise<unknown> {
  const { id, args, masterApi } = session;
  if (id !== 'usage') return unhandled;
  const { values } = parseArgs({ args, options: { days: { type: 'string' } } });
  const days = values.days === undefined ? null : Number(values.days);
  if (days !== null && !(days > 0)) throw new Error('Use master usage [--days N], N the days the by-role, by-model and by-account breakdowns cover');
  const summary: CostSummary = await masterApi(`costs${days ? `?days=${days}` : ''}`);
  return console.log(costReport(summary, Date.now()));
}
