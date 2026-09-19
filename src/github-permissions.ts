/**
 * The single declaration of what each Graphyard GitHub App identity may do. The App manifest,
 * the setup guide, the startup preflight, the integration-job holds, and the migration command
 * all read this table, so a feature that needs a new permission declares it here and nowhere
 * else. Anything not declared here is not requested and is never silently relied upon.
 */
export type PermissionLevel = 'read' | 'write' | 'admin';
export type PermissionFeature = 'repository' | 'observation' | 'check' | 'review-dispatch' | 'comment-events' | 'merge-queue';
export interface PermissionRequirement { permission: string; level: PermissionLevel; feature: PermissionFeature; reason: string }
export interface PermissionShortfall { permission: string; required: PermissionLevel; granted: PermissionLevel | null; features: PermissionFeature[]; reasons: string[] }

const levels: PermissionLevel[] = ['read', 'write', 'admin'];
export const permissionLabels: Record<string, string> = { metadata: 'Metadata', contents: 'Contents', pull_requests: 'Pull requests', issues: 'Issues', checks: 'Checks', administration: 'Administration' };
export const featureLabels: Record<PermissionFeature, string> = {
  repository: 'repository access', observation: 'pull request observation', check: 'the required check',
  'review-dispatch': 'review dispatch', 'comment-events': 'comment webhooks', 'merge-queue': 'the merge queue',
};

/** The control-plane App: it observes, publishes the gate check, dispatches reviews, and lands the queue. */
export const controlPlanePermissions: readonly PermissionRequirement[] = [
  { permission: 'metadata', level: 'read', feature: 'repository', reason: 'read the managed repository' },
  { permission: 'contents', level: 'read', feature: 'observation', reason: 'read commits, trees and pull request files' },
  { permission: 'contents', level: 'write', feature: 'merge-queue', reason: 'publish speculative merge-queue tips: the merge commit on the candidate branch and the `refs/graphyard/queue/*` ref that binds it' },
  { permission: 'pull_requests', level: 'read', feature: 'observation', reason: 'read pull requests and reviews' },
  { permission: 'pull_requests', level: 'write', feature: 'review-dispatch', reason: 'post review request comments' },
  { permission: 'issues', level: 'read', feature: 'comment-events', reason: 'receive `issue_comment` webhooks carrying review results' },
  { permission: 'checks', level: 'read', feature: 'observation', reason: 'read CI check runs' },
  { permission: 'checks', level: 'write', feature: 'check', reason: 'publish `Graphyard / merge` on the exact candidate commit' },
  { permission: 'administration', level: 'read', feature: 'observation', reason: 'inspect branch protection' },
];
/**
 * A reviewer App reads code and writes pull request comments. It deliberately never gains
 * `contents: write`, `checks`, or `administration`: a reviewer can neither publish Graphyard's
 * own gate check, change protection, nor write source code. Worker identities are not Apps
 * at all; they push their own branches with their own credentials.
 */
export const reviewerPermissions: readonly PermissionRequirement[] = [
  { permission: 'metadata', level: 'read', feature: 'repository', reason: 'read the managed repository' },
  { permission: 'contents', level: 'read', feature: 'observation', reason: 'read the code under review' },
  { permission: 'pull_requests', level: 'write', feature: 'review-dispatch', reason: 'post the verdict comment' },
  { permission: 'issues', level: 'read', feature: 'comment-events', reason: 'follow `issue_comment` events on the reviewed pull request' },
];
export const controlPlaneEvents = ['pull_request', 'pull_request_review', 'issue_comment', 'check_run', 'check_suite', 'push'] as const;
export const reviewerEvents = ['pull_request', 'issue_comment'] as const;

const rank = (level: PermissionLevel | null | undefined) => (level ? levels.indexOf(level) : -1);
const asLevel = (value: unknown): PermissionLevel | null => (typeof value === 'string' && levels.includes(value as PermissionLevel) ? value as PermissionLevel : null);

/** The highest level each permission needs: exactly what the App manifest requests. */
export function requiredPermissions(set: readonly PermissionRequirement[]): Record<string, PermissionLevel> {
  const result: Record<string, PermissionLevel> = {};
  for (const requirement of set) if (rank(requirement.level) > rank(result[requirement.permission])) result[requirement.permission] = requirement.level;
  return Object.fromEntries(Object.keys(result).sort().map(key => [key, result[key]]));
}
/** What the App still lacks, given the permissions GitHub reports for its installation. */
export function permissionShortfalls(granted: Record<string, unknown> | null | undefined, set: readonly PermissionRequirement[]): PermissionShortfall[] {
  const shortfalls = new Map<string, PermissionShortfall>();
  for (const requirement of set) {
    const level = asLevel(granted?.[requirement.permission]);
    if (rank(level) >= rank(requirement.level)) continue;
    const entry = shortfalls.get(requirement.permission) ?? { permission: requirement.permission, required: requirement.level, granted: level, features: [], reasons: [] };
    if (rank(requirement.level) > rank(entry.required)) entry.required = requirement.level;
    if (!entry.features.includes(requirement.feature)) entry.features.push(requirement.feature);
    entry.reasons.push(requirement.reason);
    shortfalls.set(requirement.permission, entry);
  }
  return [...shortfalls.values()].sort((a, b) => a.permission < b.permission ? -1 : a.permission > b.permission ? 1 : 0);
}
/** Features that cannot run until the listed shortfalls are accepted. */
export function blockedFeatures(shortfalls: readonly PermissionShortfall[]): PermissionFeature[] {
  return [...new Set(shortfalls.flatMap(shortfall => shortfall.features))];
}
export const permissionLabel = (permission: string) => permissionLabels[permission] ?? permission;
export const describePermission = (permission: string, level: PermissionLevel) => `${permissionLabel(permission)}: ${level}`;
/**
 * One operator-facing sentence per shortfall. It names the missing permission, why it is
 * needed, and the installation page where a pending permission request is accepted.
 */
export function describeShortfall(shortfall: PermissionShortfall, app: string, installationUrl: string) {
  const held = shortfall.features.map(feature => featureLabels[feature]).join(', ');
  return `App ${app} lacks ${describePermission(shortfall.permission, shortfall.required)}${shortfall.granted ? ` (installed with ${shortfall.granted})` : ''}, which ${held} needs to ${shortfall.reasons[shortfall.reasons.length - 1]}; accept the pending permission request at ${installationUrl}`;
}
/** The Markdown table the setup guide carries; a test keeps the guide equal to this output. */
export function permissionTable(set: readonly PermissionRequirement[]) {
  const required = requiredPermissions(set);
  const rows = Object.entries(required).map(([permission, level]) => {
    const reasons = set.filter(requirement => requirement.permission === permission).map(requirement => `${requirement.reason} (${featureLabels[requirement.feature]})`);
    return `| ${permissionLabel(permission)} | ${level === 'write' ? 'Read and write' : level === 'admin' ? 'Admin' : 'Read'} | ${reasons.join('; ')} |`;
  });
  return ['| Permission | Access | Needed to |', '| --- | --- | --- |', ...rows].join('\n');
}
