// Concern: goal case changes awaiting an independent approver, listed in master status until judged (GY-1805).
import { agentOwner } from '../master.js';
import { caseChangeGoalsPath, requestedCaseChanges } from '../model/goal-plan.js';
import type { ReportSections } from '../master/sections.js';

export async function pendingCaseChanges(sections: ReportSections, masterApi: (path: string) => Promise<any>) {
  const changes = await sections.optional('case changes', 'GET /api/goals', async () => requestedCaseChanges((await masterApi(caseChangeGoalsPath)).goals), () => []);
  const items = changes.map(change => ({ subject: change.work, text: `Case change ${change.id} on ${change.goal} (${change.cases.join(', ')}) requested by ${change.requestedBy} at ${change.requestedAt} awaits an independent approver: ${change.reason.slice(0, 200)}`,
    ...agentOwner('master', `graphyard goal case-change-approve ${change.goal} ${change.id} -- REASON (or case-change-refuse)`) }));
  return { changes, items };
}
