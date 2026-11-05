import { z } from 'zod';
import { deliveryModes, deploymentAdapters } from '../model/delivery-policy.js';
import { projectDeliveryShape } from './project-applications.js';
import { applicationProblems } from '../model/project-applications.js';
/** One classified check: its name, the command that runs it when one is known, and why it sits where it does. */
export const gateCheckSchema = z.object({
  check: z.string().trim().min(1).max(100),
  command: z.string().max(500).nullable(),
  source: z.enum(['script', 'workflow', 'framework']),
  paths: z.array(z.string().min(1)).optional(),
  selection: z.object({
    command: z.string().min(1),
    pattern: z.string().min(1),
    durations: z.string().min(1).optional(),
  }).strict().optional(),
  reason: z.string().max(300),
}).strict();

export const mergeGateSchema = z.object({
  /** Required on every pull request: build, typecheck, lint and fast unit checks only. */
  preMerge: z.array(gateCheckSchema).max(20),
  /** Run once per release candidate against its pinned SHA, never as a pull-request requirement. */
  perCandidate: z.array(gateCheckSchema).max(20),
}).strict();

const cron = z.string().trim().regex(/^\S+(?: \S+){4}$/, 'candidateSchedule is a five-field cron expression, or null for on-demand candidates only');

export const deliveryPolicySchema = z.object({
  mode: z.enum(deliveryModes),
  mergeGate: mergeGateSchema,
  /** When the candidate workflow cuts main's tip; null cuts on demand (workflow_dispatch) only. */
  candidateSchedule: cron.nullable(),
  deploy: z.object({
    adapter: z.enum(deploymentAdapters),
    /** Railway only: the existing project whose uat and production environments the adapter uses; null plans a new one. */
    project: z.string().trim().min(1).max(200).nullable().default(null),
    /** Command adapter only: the command that deploys $GRAPHYARD_CANDIDATE_SHA to UAT, and to production. Never guessed. */
    uat: z.string().trim().min(1).max(1000).nullable().default(null),
    production: z.string().trim().min(1).max(1000).nullable().default(null),
  }).strict(),
  ...projectDeliveryShape,
}).strict().superRefine((policy, context) => {
  for (const message of applicationProblems(policy)) context.addIssue({ code: 'custom', path: ['cases'], message });
});
